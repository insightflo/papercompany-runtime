// server/src/services/missions/owner-action-completion.ts
//
// [파일 목적] mission_main_executor_unblock 이슈가 done으로 닫히기 전에 source(originId) 회복을
//   "직접 retry/checkout 없이" 처리하는 completion service. 검증된 native DAG 헬퍴
//   (dispatchSourceIssueNativeResume → wakeExistingWorkflowStepIssue) 가 유일한 wake 경로다.
//   정상 경로: (1) source 가 blocked 이고 native step link 가 증명되면 wakeExistingWorkflowStepIssue
//   로 workflow_resume native dispatch, (2) 이미 live native wake 가 있으면 observe-only,
//   (3) native link 증명 불가면 structured report 만 남긴다(직접 wake 금지). 이후 구조화 handback
//   report 를 unblock 에 기록 → done(guard 가 검증된 report 또는 live wake/회복 으로 통과).
// [주요 흐름]
//   1. unblock + source(originId) 조회(company scope).
//   2. source 회복/terminal check → 회복 시 done, terminal mission 거부.
//   3. evidence 수집 → dispatchSourceIssueNativeResume 로 native dispatch 시도.
//   4. outcome → dispatchKind·wakeupRequestId 분류. 구조화 report comment 기록 → done.
// [수정시 주의] source 직접 checkout/status 변경/새 endpoint/범용 retry framework 금지. 공식
//   retry/iteration/QA verdict 는 workflow layer 소유. wake 은 오직 검증된 native workflow_resume
//   경로(wakeExistingWorkflowStepIssue)로만 — bare queueIssueAssignmentWakeup 합성 금지.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues, missions } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { dispatchSourceIssueNativeResume, type SourceIssueNativeResumeOutcome } from "../workflow/source-issue-native-resume.js";
import {
  buildUnblockHandbackReportComment,
  deriveUnblockDispatchClassification,
  gatherUnblockSourceEvidence,
  handUnblockReportToOversightOwner,
  type UnblockDispatchKind,
} from "./owner-action-unblock-handback.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { loadAuthorizedNativeToolStepRecovery } from "./tool-step-recovery-result.js";
import type { WorkflowSyncSource } from "../workflow/workflow-sync-source.js";

export interface CompleteUnblockHandbackResult {
  wakeupRequestId: string | null;
  dispatchKind: UnblockDispatchKind;
  sourceIssueId: string | null;
  nativeOutcome: SourceIssueNativeResumeOutcome | null;
  // report-only 경로에서 Oversight owner work item 을 깨운 wakeup(queue evidence).
  oversightWakeupRequestId: string | null;
}

export async function completeUnblockActionWithSourceHandback(
  db: Db,
  input: {
    unblockIssueId: string;
    companyId: string;
    actor: { agentId?: string | null; userId?: string | null };
    workflowSyncSource?: WorkflowSyncSource;
  },
): Promise<CompleteUnblockHandbackResult> {
  const svc = issueService(db);
  // native wake 은 dispatchSourceIssueNativeResume → wakeExistingWorkflowStepIssue 가 internally
  //   heartbeatService(db) 로 수행한다. 여기서 직접 wake/queue 호출은 없다.

  // unblock 이슈 조회 — company scope.
  const [unblock] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.unblockIssueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!unblock) throw notFound("Unblock issue not found");
  if (unblock.originKind !== "mission_main_executor_unblock") {
    throw unprocessable("Issue is not a mission_main_executor_unblock issue");
  }

  const sourceIssueId = unblock.originId;
  // source가 없으면 그냥 done(guard도 originId null로 early return).
  if (!sourceIssueId) {
    await svc.update(unblock.id, { status: "done", workflowSyncSource: input.workflowSyncSource });
    return { wakeupRequestId: null, dispatchKind: "report_only", sourceIssueId: null, nativeOutcome: null, oversightWakeupRequestId: null };
  }

  // source 이슈 조회 — 같은 company scope.
  const [source] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!source) throw notFound("Source issue not found");

  // source가 이미 회복(blocked 아님)이면 handback 불필요 — 이전 동작 유지하며 done(terminal
  //   mission check 보다 먼저, recovered source 는 handback 대상이 아니므로).
  if (source.status !== "blocked") {
    await svc.update(unblock.id, { status: "done", workflowSyncSource: input.workflowSyncSource });
    return { wakeupRequestId: null, dispatchKind: "report_only", sourceIssueId: source.id, nativeOutcome: null, oversightWakeupRequestId: null };
  }

  // mission terminal check — terminal mission의 issue는 handback하면 안 됨.
  if (source.missionId) {
    const [mission] = await db
      .select({ status: missions.status })
      .from(missions)
      .where(and(eq(missions.id, source.missionId), eq(missions.companyId, input.companyId)))
      .limit(1);
    if (mission && (mission.status === "completed" || mission.status === "cancelled")) {
      throw conflict("Cannot complete handback for a source issue in a terminal (completed/cancelled) mission");
    }
  }
  const ownerDecision = await loadLatestMissionOwnerDecision({
    db,
    companyId: input.companyId,
    ownerActionIssueId: unblock.id,
  });
  // recover_artifact may only use the generic handback after the structured decision and official
  // Workflow API registration jointly prove the artifact. Missing or cross-scope evidence is a no-op.
  if (ownerDecision?.decision.decision === "recover_artifact") {
    const handbackMissionId = source.missionId ?? unblock.missionId;
    const missionRow = handbackMissionId
      ? await db
          .select({ ownerAgentId: missions.ownerAgentId })
          .from(missions)
          .where(and(eq(missions.id, handbackMissionId), eq(missions.companyId, input.companyId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const authorizedRecovery = handbackMissionId && missionRow?.ownerAgentId
      ? await loadAuthorizedNativeToolStepRecovery({
          db,
          companyId: input.companyId,
          missionId: handbackMissionId,
          missionOwnerAgentId: missionRow.ownerAgentId,
          ownerActionIssue: { id: unblock.id, identifier: unblock.identifier ?? null, originId: unblock.originId },
          sourceIssue: { id: source.id, identifier: source.identifier ?? null },
        })
      : null;
    if (!authorizedRecovery) {
      return {
        wakeupRequestId: null,
        dispatchKind: "report_only",
        sourceIssueId: source.id,
        nativeOutcome: null,
        oversightWakeupRequestId: null,
      };
    }
  }

  const evidence = await gatherUnblockSourceEvidence(db, { companyId: input.companyId, source });

  // [req] source 가 blocked 일 때 검증된 native DAG 헬퍼로만 wake 시도. bare
  //   queueIssueAssignmentWakeup 합성 없이 wakeExistingWorkflowStepIssue 가 link/run/definition/step
  //   를 증명하고 workflow_step_runnable/workflow_resume 계약으로 wake 한다.
  const outcome: SourceIssueNativeResumeOutcome = await dispatchSourceIssueNativeResume(db, {
    companyId: input.companyId,
    issueId: source.id,
    allowBlockedIssue: true,
    agentId: source.assigneeAgentId,
  });

  let dispatchedWakeupRequestId: string | null = null;
  let oversightWakeupRequestId: string | null = null;
  let dispatchKind: UnblockDispatchKind = "report_only";
  const classification = deriveUnblockDispatchClassification(evidence, outcome);
  if (outcome.kind === "dispatched") {
    dispatchKind = "workflow_resume";
    dispatchedWakeupRequestId = await resolveDispatchedWakeupRequestId(db, {
      companyId: input.companyId,
      sourceId: source.id,
      agentId: source.assigneeAgentId ?? "",
    });
  } else if (outcome.kind === "already_in_flight") {
    dispatchKind = "native_resume_in_flight";
    dispatchedWakeupRequestId = outcome.workflowWakeupRequestId;
  } else {
    dispatchKind = "report_only";
    const reportComment = await svc.addComment(
      unblock.id,
      buildUnblockHandbackReportComment(evidence, classification, null, null),
      {
        agentId: input.actor.agentId ?? undefined,
        userId: input.actor.userId ?? undefined,
      },
    );
    oversightWakeupRequestId = await handUnblockReportToOversightOwner(db, {
      companyId: input.companyId,
      missionId: source.missionId ?? unblock.missionId,
      unblockIssueId: unblock.id,
      reportCommentId: reportComment.id,
      handback: {
        sourceIssueId: source.id,
        failureClass: classification.failureClass,
        sourceLiveRunWakeState: evidence.liveRunId || evidence.liveWakeupRequestId ? "live" : "none",
        recommendedNativeAction: classification.recommendedNativeAction,
        failedRunId: evidence.failedRunId,
        workflowRunId: evidence.workflowRunId,
        workflowStepRunId: evidence.workflowStepRunId,
        stepId: evidence.stepId,
      },
    });
    if (!oversightWakeupRequestId) {
      throw conflict("Report-only unblock handback did not enter the live Oversight execution queue");
    }
    await svc.addComment(
      unblock.id,
      `Oversight handback queue accepted (wakeupRequestId: ${oversightWakeupRequestId}).`,
      {
        agentId: input.actor.agentId ?? undefined,
        userId: input.actor.userId ?? undefined,
      },
    );
  }

  if (dispatchKind !== "report_only") {
    await svc.addComment(
      unblock.id,
      buildUnblockHandbackReportComment(evidence, classification, dispatchedWakeupRequestId, null),
      {
        agentId: input.actor.agentId ?? undefined,
        userId: input.actor.userId ?? undefined,
      },
    );
  }

  // done 표시 — guard 가 (a) source 회복 (b) source live wake (c) 검증된 구조화 report 중 하나로 통과.
  await svc.update(unblock.id, { status: "done", workflowSyncSource: input.workflowSyncSource });
  return {
    wakeupRequestId: dispatchedWakeupRequestId,
    dispatchKind,
    sourceIssueId: source.id,
    nativeOutcome: outcome,
    oversightWakeupRequestId,
  };
}

// native dispatch 가 queue admission 에 만든 agent_wakeup_requests row 를 회수(응답/감사용).
// idempotencyKey 컬럼이 별도로 없으므로 (companyId, issueId, agentId) 최신 row 로 충분 — 방금
// dispatch 한 직후이므로 최신이 곧 row. agentId 가 없으면 조회의미 없어 null.
async function resolveDispatchedWakeupRequestId(
  db: Db,
  input: { companyId: string; sourceId: string; agentId: string },
): Promise<string | null> {
  if (!input.agentId) return null;
  const [row] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, input.sourceId),
      eq(agentWakeupRequests.agentId, input.agentId),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  return row?.id ?? null;
}
