// server/src/services/workflow/source-issue-native-resume.ts
//
// [파일 목적] owner-action 회복(Unblock 완료 · owner-decision retry)이 source issue 를 깨울 때
//   반드시 "검증된 native workflow/DAG 경로"만 쓰도록 강제하는 공유 헬퍼. bare
//   queueIssueAssignmentWakeup(mutation=workflow_resume) payload 를 라벨만 붙여 합성하는 것이
//   아니라, 실제 workflowRun(running) · workflowDefinition · persisted step · workflowStepRun 을
//   조인으로 증명한 뒤 wakeExistingWorkflowStepIssue(workflow_step_runnable/workflow_resume 계약의
//   단일 소유자) 로 wake 한다. native link 를 증명할 수 없으면 report-only (wake 안 함).
// [주요 흐름]
//   1. source issue 의 최신 workflowStepRun 조회(없으면 report-only).
//   2. workflowRun 조회 — 반드시 status=running(아니면 report-only).
//   3. workflowDefinition 조회(없으면 report-only).
//   4. buildWorkflowExecutionSteps(definition) 로 persisted step 해석 — stepId 불일치면 report-only.
//   5. (agentId 제공 시) findExistingWorkflowResumeWake 로 이미 native wake 가 있으면 already_in_flight.
//   6. wakeExistingWorkflowStepIssue(allowBlockedIssue) 로 wake. 거부되면 report-only.
// [계약] 공식 retry/iteration/QA verdict 는 workflow layer 소유. 여기서 source status 를 직접
//   변경/checkout 하지 않는다(wakeExistingWorkflowStepIssue 는 assignee 누락 시에만 assignee 를
//   복원하고 status 는 건드리지 않는다 — 이것이 native 계약). 새 endpoint · 범용 retry framework 없음.
// [수정시 영향] failureClass/reason 분기가 바뀌면 owner-action-completion · app.ts callback 의
//   dispatchKind 매핑과 done closeout guard 가 정렬되어야 한다.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { buildWorkflowExecutionSteps, wakeExistingWorkflowStepIssue, type WorkflowStep } from "./dag-engine.js";
import { resumeWorkflowRun } from "./workflow-store.js";
import { applyOwnerCapOverrideRetry } from "./source-issue-cap-override.js";
import { recoverOwnerCapOverride } from "./source-issue-cap-override-recovery.js";
import { findExistingWorkflowResumeWake } from "../workflow-resume-wake.js";

// "live" 실행 신호 상태 집합 — owner-action-unblock-handback.ts LIVE_WAKEUP_STATUSES 와 동일 집합.
//   이슈가 이 상태의 wake 나 queued/running heartbeat 를 가지면 중복 dispatch 금지.
const LIVE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution", "coalesced"] as const;
const LIVE_HEARTBEAT_STATUSES = ["queued", "running"] as const;

// 검증 실패 이유 — report-only 증거로 report comment 에 기록된다.
export type SourceIssueNativeResumeReportReason =
  | "no_step_run"
  | "run_not_running"
  | "no_definition"
  | "step_not_found"
  | "wake_rejected"
  // cap-override(failed run + completed producer at/beyond cap 의 owner 1회 retry) 검증 거부 사유.
  | "cap_override_wrong_scope"
  | "cap_override_no_current_request_changes"
  | "cap_override_under_cap"
  | "cap_override_no_back_edge"
  | "cap_override_no_marker"
  | "cap_override_queue_rolled_back";

export type SourceIssueNativeResumeOutcome =
  | {
      kind: "dispatched";
      workflowRunId: string;
      workflowDefinitionId: string;
      stepId: string;
      workflowStepRunId: string;
    }
  | {
      kind: "already_in_flight";
      // 중복 억제 신호가 wake 이면其 id, heartbeat run 만 live 이면 null. caller 는 어느 쪽이든
      //   "이미 진행 중" 으로 취급한다(native_resume_in_flight / workflow_already_dispatched).
      workflowWakeupRequestId: string | null;
      runId: string | null;
      liveSignal: "wake" | "heartbeat";
    }
  // [cap-override] owner 가 QA rework cap 초과 producer 1회 retry(failed run + completed producer
  //   at/beyond cap + current official RC verdict + same-company/same-mission owner action). one-shot audit.
  | { kind: "cap_override_applied"; workflowRunId: string; workflowDefinitionId: string; stepId: string; workflowStepRunId: string; ownerActionIssueId: string; fromIteration: number; toIteration: number; cap: number }
  | { kind: "cap_override_already_applied"; ownerActionIssueId: string }
  | {
      kind: "report_only";
      reason: SourceIssueNativeResumeReportReason;
      // 증명 단계에서 확보한 link 정보(없을 수 있다). report comment 의 evidence 로 쓰인다.
      workflowRunId: string | null;
      workflowStepRunId: string | null;
      stepId: string | null;
    };

// [입력] companyId(스코프 가드) · issueId(source) · allowBlockedIssue(blocked source 허용, 기본 true).
//   agentId 를 주면 findExistingWorkflowResumeWake 로 중복 native wake 를 먼저 단락한다.
// [출력] dispatched | already_in_flight | report_only. caller 가 각각 dispatchKind/return shape 로 매핑.
// [연결] owner-action-completion(Unblock) · app.ts onOwnerDecisionRetrySourceIssueApplied 가 공통 사용.
export async function dispatchSourceIssueNativeResume(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    allowBlockedIssue?: boolean;
    agentId?: string | null;
    // [cap-override] mission owner retry_source_issue owner-action(failed run + completed producer at/beyond cap 일 때 분기).
    //   authority = 실제 owner-action decision comment ID(cap-override 가 DB 에서 fail-closed 검증).
    ownerAction?: { ownerActionIssueId: string; missionId: string; decisionCommentId: string };
    /** [test isolation] optional wake dependency — production omits (uses real wakeExistingWorkflowStepIssue).
     *  tests inject a no-spawn wake that still creates the exact-key agentWakeupRequests row (contract preserved). */
    wakeFn?: typeof wakeExistingWorkflowStepIssue;
  },
): Promise<SourceIssueNativeResumeOutcome> {
  // 1. source issue 의 최신 step run. startedAt/completedAt desc 로 "가장 진행된" run 을 잡는다.
  // [BLOCKER1] durable crash-window recovery FIRST: a prior cap-override forward may have committed
  //   (run=running/step=pending/issue=todo/audit=pending) and crashed before wake. resolve any existing
  //   audit for this decision before the failed/completed gate. returns null when no audit → fresh/normal path.
  if (input.ownerAction) {
    const recovered = await recoverOwnerCapOverride(db, { companyId: input.companyId, issueId: input.issueId, allowBlockedIssue: input.allowBlockedIssue, ownerAction: input.ownerAction, wakeFn: input.wakeFn });
    if (recovered) return recovered;
  }
  const [stepRun] = await db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
      completedAt: workflowStepRuns.completedAt,
      metadata: workflowStepRuns.metadata,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, input.issueId))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
    .limit(1);
  if (!stepRun) {
    return { kind: "report_only", reason: "no_step_run", workflowRunId: null, workflowStepRunId: null, stepId: null };
  }

  // 2. workflowRun — running 은 그대로 사용하고, failed 만 native retry 대상으로 되살린다.
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, stepRun.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
    .limit(1);
  if (!run || (run.status !== "running" && run.status !== "failed")) {
    return {
      kind: "report_only",
      reason: "run_not_running",
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
      stepId: stepRun.stepId,
    };
  }

  // [cap-override] failed run + completed producer(at/beyond cap) + owner action → cap 초과 1회 retry.
  if (run.status === "failed" && stepRun.status === "completed" && input.ownerAction) {
    return applyOwnerCapOverrideRetry(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      allowBlockedIssue: input.allowBlockedIssue ?? true,
      ownerAction: input.ownerAction,
      wakeFn: input.wakeFn,
    });
  }

  // 3. definition — company scope 가드(타 회사 definition 우발 매칭 방지)로 조회.
  const [definition] = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, run.workflowId), eq(workflowDefinitions.companyId, input.companyId)))
    .limit(1);
  if (!definition) {
    return {
      kind: "report_only",
      reason: "no_definition",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: stepRun.stepId,
    };
  }

  // 4. definition 으로부터 persisted step 를 재조립하고 stepRun.stepId 가 실제 존재하는지 확인.
  //   이 단계를 통과해야 "native DAG 가 아는 step" 이 보증된다(할당/iteration/retry 계약의 주체).
  const steps: WorkflowStep[] = buildWorkflowExecutionSteps(definition);
  const step = steps.find((candidate) => candidate.id === stepRun.stepId) ?? null;
  if (!step) {
    return {
      kind: "report_only",
      reason: "step_not_found",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: stepRun.stepId,
    };
  }
  const existingWorkflowResumeWake = input.agentId
    ? await findExistingWorkflowResumeWake(db, {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
      })
    : null;
  if (existingWorkflowResumeWake) {
    return {
      kind: "already_in_flight",
      workflowWakeupRequestId: existingWorkflowResumeWake.id,
      runId: existingWorkflowResumeWake.runId,
      liveSignal: "wake",
    };
  }

  // 5. 중복 wake 억제 — narrow native-only 체크가 아니라 "이슈에 이미 live 실행 신호가 있으면"
  //   dispatch 금지. native OR generic wake(queued/claimed/deferred_issue_execution/coalesced) 또는
  //   queued/running heartbeat run 모두 커버한다(회사 스코프). 이슈 단위이므로 agentId 무관.
  const [liveWake] = await db
    .select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
      requestKind: agentWakeupRequests.requestKind,
      workflowRunId: agentWakeupRequests.workflowRunId,
      workflowStepRunId: agentWakeupRequests.workflowStepRunId,
    })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, input.issueId),
      inArray(agentWakeupRequests.status, [...LIVE_WAKEUP_STATUSES]),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  if (liveWake) {
    if (
      liveWake.requestKind === "workflow_resume" &&
      liveWake.workflowRunId === run.id &&
      liveWake.workflowStepRunId === stepRun.id
    ) {
      return { kind: "already_in_flight", workflowWakeupRequestId: liveWake.id, runId: liveWake.runId, liveSignal: "wake" };
    }
    return {
      kind: "report_only",
      reason: "wake_rejected",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: step.id,
    };
  }
  const [liveHeartbeat] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, input.issueId),
      inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
    ))
    .limit(1);
  if (liveHeartbeat) {
    return {
      kind: "report_only",
      reason: "wake_rejected",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: step.id,
    };
  }

  const existingNativeWakeIds = new Set(
    (await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.issueId, input.issueId),
        eq(agentWakeupRequests.workflowRunId, run.id),
        eq(agentWakeupRequests.workflowStepRunId, stepRun.id),
        eq(agentWakeupRequests.requestKind, "workflow_resume"),
      )))
      .map((row) => row.id),
  );

  let wakeRun = run;
  const revivedFailedRun = run.status === "failed";
  const restoreFailedState = async () => {
    if (!revivedFailedRun) return;
    await db.update(workflowRuns).set({ status: "failed", startedAt: run.startedAt, completedAt: run.completedAt }).where(eq(workflowRuns.id, run.id));
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: stepRun.completedAt }).where(eq(workflowStepRuns.id, stepRun.id));
  };
  if (revivedFailedRun) {
    if (stepRun.status !== "failed") {
      return {
        kind: "report_only",
        reason: "wake_rejected",
        workflowRunId: run.id,
        workflowStepRunId: stepRun.id,
        stepId: step.id,
      };
    }
    const resumedRun = await resumeWorkflowRun(db, run.id, input.companyId);
    const [resumedStep] = await db
      .update(workflowStepRuns)
      .set({ status: "running", completedAt: null })
      .where(and(eq(workflowStepRuns.id, stepRun.id), eq(workflowStepRuns.status, "failed")))
      .returning({ id: workflowStepRuns.id });
    const [rawResumedRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, input.companyId)))
      .limit(1);
    if (!resumedRun || !resumedStep || !rawResumedRun) {
      await restoreFailedState();
      return {
        kind: "report_only",
        reason: "wake_rejected",
        workflowRunId: run.id,
        workflowStepRunId: stepRun.id,
        stepId: step.id,
      };
    }
    wakeRun = rawResumedRun;
  }

  // 6. 검증 완료 — wakeExistingWorkflowStepIssue 가 workflow_step_runnable/workflow_resume 계약으로
  //   native wake 를 소유한다. 이 호출만이 공식 retry/iteration/QA verdict 를 보존한다.
  let queued = false;
  try {
    queued = await (input.wakeFn ?? wakeExistingWorkflowStepIssue)({
      db,
      run: wakeRun,
      definition,
      step,
      stepRunId: stepRun.id,
      stepRunMetadata: stepRun.metadata,
      issueId: input.issueId,
      allowBlockedIssue: input.allowBlockedIssue ?? true,
    });
  } catch {
    await restoreFailedState();
    return {
      kind: "report_only",
      reason: "wake_rejected",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: step.id,
    };
  }
  const acceptedQueueStatuses = new Set(["queued", "claimed", "deferred_issue_execution", "coalesced", "completed"]);
  const newNativeWakes = (await db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, input.issueId),
      eq(agentWakeupRequests.workflowRunId, run.id),
      eq(agentWakeupRequests.workflowStepRunId, stepRun.id),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
    )))
    .filter((row) => !existingNativeWakeIds.has(row.id) && acceptedQueueStatuses.has(row.status));
  if (!queued || newNativeWakes.length !== 1) {
    await restoreFailedState();
    return {
      kind: "report_only",
      reason: "wake_rejected",
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      stepId: step.id,
    };
  }
  return {
    kind: "dispatched",
    workflowRunId: run.id,
    workflowDefinitionId: definition.id,
    stepId: step.id,
    workflowStepRunId: stepRun.id,
  };
}
