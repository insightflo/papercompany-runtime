import { agentWakeupRequests, agents, heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AutomaticSourceRecovery } from "../workflow/source-issue-native-resume.js";
import { issueService } from "../issues.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import { describeMissionExecutionLiaisonBoundary, isMissionExecutionLiaisonAgent, isRunnableMissionExecutionAssigneeStatus } from "./agent-role-boundaries.js";
import {
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildMissionOwnerDecisionWakeupIdempotencyKey,
} from "./mission-owner-recovery-events.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js"; import type { SystemLanguage } from "./system-language.js";
import {
  normalizeMissionOwnerDecisionWakeupDispatchResult,
  type MissionOwnerDecisionWakeupDispatchStatus,
  type MissionOwnerSupervisionAppliedAction,
} from "./supervision-types.js";

type ReassignSourceIssueDecision = {
  readonly decision: "reassign_source_issue";
  readonly targetAgentId?: string;
  readonly nextAction?: string;
  readonly reason?: string;
  readonly evidence?: string;
};

type ReassignSourceIssueResult = {
  readonly findings: string[];
  readonly appliedAction?: MissionOwnerSupervisionAppliedAction;
};

export function buildReassignSourceIssueComment(input: { readonly language?: SystemLanguage;
  readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string;
  readonly sourceIssueId: string;
  readonly sourceLabel: string;
  readonly previousAgentId: string | null;
  readonly targetAgentId: string;
  readonly decisionReason?: string;
}): string {
  return [
    input.language === "ko" ? "### Mission owner reassignment applied\n원래 업무의 담당자를 변경했습니다. 담당 변경만으로 실행을 확인할 수 없습니다. 다음 행동: 실행 요청 결과와 실행 기록을 확인해 주세요." : "### Mission owner reassignment applied\nThe source issue now has a new assignee. This assignment change does not confirm execution; check the wakeup result and run record next.",
    buildMissionOwnerDecisionAppliedMarker({ ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.sourceIssueId, decision: "reassign_source_issue" }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Previous assignee: ${input.previousAgentId ?? "unassigned"}`,
    `Target assignee: ${input.targetAgentId}`,
    `Reason: ${input.decisionReason ?? "Owner requested source issue reassignment."}`,
  ].join("\n");
}
export function buildReassignSourceIssueWakeupResultComment(input: {
  readonly language?: SystemLanguage; readonly status: MissionOwnerDecisionWakeupDispatchStatus; readonly missionId: string; readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string; readonly sourceIssueId: string; readonly sourceLabel: string; readonly targetAgentId: string; readonly idempotencyKey: string;
}): string {
  return [
    input.language === "ko" ? (input.status === "workflow_already_dispatched" ? "### Mission owner reassignment wakeup handled by workflow\n기존 작업 흐름 재개 요청이 있어 추가 실행을 요청하지 않았습니다. 다음 행동: 기존 실행 기록을 확인해 주세요." : "### Mission owner reassignment wakeup dispatched\n새 담당자에게 실행을 요청했습니다. 실제 실행은 아직 확인되지 않았습니다. 다음 행동: 다음 실행 기록을 확인해 주세요.") : input.status === "workflow_already_dispatched" ? "### Mission owner reassignment wakeup handled by workflow\nAn existing workflow resume request covers the issue; no second wakeup was requested. Check the existing run next." : "### Mission owner reassignment wakeup dispatched\nA wakeup was requested for the new assignee; execution is not confirmed. Check the next run record.",
    buildMissionOwnerDecisionWakeupDispatchedMarker({ missionId: input.missionId, ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.sourceIssueId, decision: "reassign_source_issue", idempotencyKey: input.idempotencyKey }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Target agent: ${input.targetAgentId}`, `Wakeup status: ${input.status}`, `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export async function applyReassignSourceIssueDecision(input: { readonly language?: SystemLanguage;
  readonly db: Db;
  readonly mission: MissionRow;
  readonly ownerActionIssue: typeof issues.$inferSelect;
  readonly ownerActionLabel: string;
  readonly ownerDecision: ReassignSourceIssueDecision;
  readonly sourceIssue: typeof issues.$inferSelect | null;
  readonly sourceLabel: string;
  readonly sourceComments: readonly string[];
  readonly sourceHasActiveHeartbeat: boolean;
  readonly sourcePlanGateReason: string | null;
  readonly now: Date;
  readonly dispatchWakeup: boolean;
  readonly onWakeup?: MissionServiceDeps["onOwnerDecisionRetrySourceIssueApplied"];
}): Promise<ReassignSourceIssueResult> {
  const findings: string[] = [];
  if (!input.sourceIssue) {
    findings.push(notApplied(input, input.sourceLabel, "owner-action issue has no canonical originId source issue"));
    return { findings };
  }

  const sourceIssue = input.sourceIssue;
  const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  const fail = (reason: string): ReassignSourceIssueResult => ({ findings: [notApplied(input, sourceLabel, reason)] });
  if (input.sourceIssue.missionId !== input.mission.id) return fail("canonical source issue belongs to a different mission");
  if (input.sourceIssue.hiddenAt) return fail("canonical source issue is hidden");
  if (input.sourceIssue.status === "done" || input.sourceIssue.status === "cancelled") {
    return fail(`canonical source issue is already terminal status=${input.sourceIssue.status}`);
  }
  if (input.sourceHasActiveHeartbeat) return fail("canonical source issue already has an active heartbeat run");
  if (input.sourcePlanGateReason) return fail(input.sourcePlanGateReason);
  const structuredDecision = await loadLatestMissionOwnerDecision({
    db: input.db,
    companyId: input.mission.companyId,
    ownerActionIssueId: input.ownerActionIssue.id,
  });
  if (
    !structuredDecision ||
    structuredDecision.decision.decision !== "reassign_source_issue" ||
    structuredDecision.missionId !== input.mission.id ||
    structuredDecision.sourceIssueId !== input.sourceIssue.id ||
    structuredDecision.authorAgentId !== input.mission.ownerAgentId
  ) return fail("a current structured owner-recovery reassign_source_issue decision is required");

  const targetAgentId =
    typeof structuredDecision.decision.targetAgentId === "string" && structuredDecision.decision.targetAgentId.trim()
      ? structuredDecision.decision.targetAgentId.trim()
      : null;
  if (!targetAgentId) {
    return fail("reassign_source_issue requires structured targetAgentId (UUID); free-text nextAction/reason/evidence is not assignment authority");
  }

  const targetAgent = await input.db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(and(eq(agents.companyId, input.mission.companyId), eq(agents.id, targetAgentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!targetAgent) return fail(`target agent ${targetAgentId} was not found in this company`);
  if (!isRunnableMissionExecutionAssigneeStatus(targetAgent.status)) {
    return fail(`target agent ${targetAgent.name} is not runnable status=${targetAgent.status || "unknown"}`);
  }
  if (isMissionExecutionLiaisonAgent(targetAgent)) return fail(describeMissionExecutionLiaisonBoundary(targetAgent));

  const idempotencyKey = buildMissionOwnerDecisionWakeupIdempotencyKey({
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    decision: "reassign_source_issue",
  });
  const actionIdempotencyKey = `${idempotencyKey}:apply`;
  const existingAction = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, actionIdempotencyKey))).limit(1);
  let updatedSourceIssue = input.sourceIssue;
  const reassigned = existingAction.length === 0 ? await input.db.transaction(async (tx) => {
    const updated = await tx.update(issues).set({
      assigneeAgentId: targetAgentId, assigneeUserId: null, status: "todo", checkoutRunId: null,
      executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, completedAt: null,
      cancelledAt: null, updatedAt: input.now,
    }).where(and(
      eq(issues.id, sourceIssue.id), eq(issues.companyId, input.mission.companyId),
      eq(issues.status, sourceIssue.status),
      inArray(issues.status, ["todo", "backlog", "blocked"]), isNull(issues.hiddenAt),
    )).returning().then((rows) => rows[0] ?? null);
    if (!updated) return null;
    const event = await tx.insert(workflowTransitionEvents).values({
      companyId: input.mission.companyId, missionId: input.mission.id, issueId: sourceIssue.id,
      heartbeatRunId: structuredDecision.heartbeatRunId, eventType: "mission_owner_recovery_action",
      layer: "mission_owner_recovery", fromStatus: sourceIssue.status, toStatus: "todo",
      decision: "reassign_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api",
      correlationId: structuredDecision.eventId, idempotencyKey: actionIdempotencyKey,
      payload: { kind: "mission_owner_recovery_action", decisionEventId: structuredDecision.eventId, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: sourceIssue.id, targetAgentId },
    }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
    if (event.length === 0) throw new Error("mission-owner-reassign-source: durable action already recorded");
    return updated;
  }) : null;
  if (!reassigned) {
    const duplicate = existingAction.length > 0 ? existingAction : await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, actionIdempotencyKey))).limit(1);
    if (duplicate.length === 0) return fail(`canonical source issue is status=${input.sourceIssue.status}, not todo/backlog/blocked for safe reassignment`);
  } else {
    updatedSourceIssue = reassigned;
    await issueService(input.db).addComment(input.sourceIssue.id, buildReassignSourceIssueComment({ language: input.language,
      ownerActionIssueId: input.ownerActionIssue.id, ownerActionLabel: input.ownerActionLabel,
      sourceIssueId: input.sourceIssue.id, sourceLabel, previousAgentId: input.sourceIssue.assigneeAgentId,
      targetAgentId, decisionReason: structuredDecision.decision.reason,
    }), { agentId: input.mission.ownerAgentId });
  }

  let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchWakeup ? "skipped_no_assignee" : "not_requested";
  if (input.dispatchWakeup) {
    const existingWake = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, idempotencyKey))).limit(1);
    if (existingWake.length === 0 && input.onWakeup) {
      try {
        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(await input.onWakeup({
          mission: input.mission, ownerActionIssue: input.ownerActionIssue, sourceIssue: updatedSourceIssue, targetAgentId, idempotencyKey,
        }));
        const wake = await input.db.insert(workflowTransitionEvents).values({
          companyId: input.mission.companyId, missionId: input.mission.id, issueId: input.sourceIssue.id,
          heartbeatRunId: structuredDecision.heartbeatRunId, eventType: "mission_owner_recovery_wakeup",
          layer: "mission_owner_recovery", decision: "reassign_source_issue", reason: "owner_recovery_api",
          reasonCode: "owner_recovery_api", correlationId: structuredDecision.eventId, idempotencyKey,
          payload: { kind: "mission_owner_recovery_wakeup", decisionEventId: structuredDecision.eventId, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: input.sourceIssue.id, targetAgentId, status: wakeupDispatchStatus },
        }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
        if (wake.length > 0) await issueService(input.db).addComment(
          input.sourceIssue.id,
          buildReassignSourceIssueWakeupResultComment({ language: input.language, status: wakeupDispatchStatus, missionId: input.mission.id, ownerActionIssueId: input.ownerActionIssue.id, ownerActionLabel: input.ownerActionLabel, sourceIssueId: input.sourceIssue.id, sourceLabel, targetAgentId, idempotencyKey }),
          { agentId: input.mission.ownerAgentId },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push(`owner_action_wakeup_failed: ${sourceLabel} reassign_source_issue wakeup callback failed — ${message}`);
        wakeupDispatchStatus = "failed";
      }
    } else if (existingWake.length === 0) {
      findings.push(`owner_action_wakeup_skipped: ${sourceLabel} dispatchOwnerDecisionWakeups enabled but no wakeup callback configured`);
      wakeupDispatchStatus = "failed";
    }
  }

  return {
    findings,
    appliedAction: {
      type: "owner_decision_reassign_source_issue",
      missionId: input.mission.id,
      ownerActionIssueId: input.ownerActionIssue.id,
      sourceIssueId: input.sourceIssue.id,
      previousAgentId: input.sourceIssue.assigneeAgentId,
      targetAgentId,
      resultStatus: updatedSourceIssue.status,
      wakeupDispatchStatus,
      idempotencyKey,
    },
  };
}

function notApplied(input: {
  readonly ownerActionLabel: string;
}, sourceLabel: string, reason: string): string {
  return summarizeOwnerDecisionNotApplied({
    ownerActionLabel: input.ownerActionLabel,
    sourceLabel,
    reason,
    decision: "reassign_source_issue",
  });
}

/** [Stage 8 자동 경로] owner_execute intent(actionId) 를 권위로 하는 guarded 재배정. 기존 human 경로의
 *  안전 검사(스코프·상태·live 신호·대상 agent 자격)와 이슈 갱신 계약을 그대로 재사용하되, 멱원 key 를
 *  actionId 에서 파생해 legacy human marker/idempotency 가 새 자동 action 을 억제하지 않게 분리한다.
 *  반환은 구조적 결과뿐 — findings/comment 자연어를 파싱하지 않는다. 실제 깨움은 호출자가 stage3 strict
 *  native 전달로 소유한다. */
export async function applyAutomaticReassignSourceIssue(input: {
  readonly db: Db; readonly companyId: string; readonly missionId: string; readonly issueId: string;
  readonly targetAgentId: string; readonly ownerExecution: AutomaticSourceRecovery;
}): Promise<{ readonly kind: "applied" | "not_applied"; readonly reasonCode: string | null;
  readonly sourceIssueId: string; readonly targetAgentId: string }> {
  const fail = (reasonCode: string) => ({ kind: "not_applied" as const, reasonCode,
    sourceIssueId: input.issueId, targetAgentId: input.targetAgentId });
  const [issue] = await input.db.select().from(issues).where(and(eq(issues.companyId, input.companyId),
    eq(issues.id, input.issueId))).limit(1);
  if (!issue) return fail("source_issue_not_found");
  if (issue.missionId !== input.missionId) return fail("source_issue_mission_mismatch");
  if (issue.hiddenAt) return fail("source_issue_hidden");
  if (issue.status === "done" || issue.status === "cancelled") return fail("source_issue_terminal");
  const [liveSignal] = await input.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.issueId, input.issueId),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced"]))).limit(1);
  const [liveHeartbeat] = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, input.issueId),
      inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
  if (liveSignal || liveHeartbeat) return fail("reassign_target_in_flight"); // 같은 업무 병렬 시작 금지 — 정확한 대기
  const [targetAgent] = await input.db.select({ id: agents.id, name: agents.name, status: agents.status,
    adapterType: agents.adapterType, runtimeConfig: agents.runtimeConfig, metadata: agents.metadata })
    .from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.targetAgentId))).limit(1);
  if (!targetAgent) return fail("target_agent_not_found");
  if (!isRunnableMissionExecutionAssigneeStatus(targetAgent.status)) return fail("target_agent_not_runnable");
  if (isMissionExecutionLiaisonAgent(targetAgent)) return fail("target_agent_liaison");
  if (!(await input.ownerExecution.validateIntent(input.db))) return fail("stale_intent");
  const idempotencyKey = `owner-execute-reassign:v1:${input.companyId}:${input.ownerExecution.actionId}`;
  const existingRows = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey))).limit(1);
  if (existingRows.length === 0) {
    const committed = await input.db.transaction(async (tx) => {
      const updated = await tx.update(issues).set({ assigneeAgentId: input.targetAgentId, assigneeUserId: null,
        status: "todo", checkoutRunId: null, executionRunId: null, executionAgentNameKey: null,
        executionLockedAt: null, completedAt: null, cancelledAt: null, updatedAt: new Date() }).where(and(
        eq(issues.id, issue.id), eq(issues.companyId, input.companyId), eq(issues.status, issue.status),
        inArray(issues.status, ["todo", "backlog", "blocked"]), isNull(issues.hiddenAt))).returning();
      if (updated.length === 0) return null;
      const event = await tx.insert(workflowTransitionEvents).values({ companyId: input.companyId,
        missionId: input.missionId, issueId: issue.id, eventType: "owner_execute_reassign_v1",
        layer: "mission_owner_authority", fromStatus: issue.status, toStatus: "todo", decision: "reassign",
        reason: "mission_owner_execute", reasonCode: "mission_owner_execute",
        correlationId: input.ownerExecution.actionId, idempotencyKey,
        payload: { schemaVersion: 1, kind: "owner_execute_reassign_v1", actionId: input.ownerExecution.actionId,
          sourceIssueId: issue.id, previousAgentId: issue.assigneeAgentId, targetAgentId: input.targetAgentId,
          workflowRunId: input.ownerExecution.workflowRunId, stepRunId: input.ownerExecution.stepRunId } })
        .onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
      if (event.length === 0) throw new Error("mission-owner-reassign: durable action already recorded");
      return updated[0]!;
    }).catch(() => null);
    if (!committed) return fail("reassign_status_not_safe");
  }
  return { kind: "applied", reasonCode: null, sourceIssueId: input.issueId, targetAgentId: input.targetAgentId };
}
