import { agents, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issueService } from "../issues.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import {
  describeMissionExecutionLiaisonBoundary,
  isMissionExecutionLiaisonAgent,
  isRunnableMissionExecutionAssigneeStatus,
} from "./agent-role-boundaries.js";
import {
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildMissionOwnerDecisionWakeupIdempotencyKey,
} from "./mission-owner-recovery-events.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js";
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

export function buildReassignSourceIssueComment(input: {
  readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string;
  readonly sourceIssueId: string;
  readonly sourceLabel: string;
  readonly previousAgentId: string | null;
  readonly targetAgentId: string;
  readonly decisionReason?: string;
}): string {
  return [
    "### Mission owner reassignment applied",
    buildMissionOwnerDecisionAppliedMarker({ ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.sourceIssueId, decision: "reassign_source_issue" }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Previous assignee: ${input.previousAgentId ?? "unassigned"}`,
    `Target assignee: ${input.targetAgentId}`,
    `Reason: ${input.decisionReason ?? "Owner requested source issue reassignment."}`,
  ].join("\n");
}
export function buildReassignSourceIssueWakeupResultComment(input: {
  readonly status: MissionOwnerDecisionWakeupDispatchStatus; readonly missionId: string; readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string; readonly sourceIssueId: string; readonly sourceLabel: string; readonly targetAgentId: string; readonly idempotencyKey: string;
}): string {
  return [
    input.status === "workflow_already_dispatched" ? "### Mission owner reassignment wakeup handled by workflow" : "### Mission owner reassignment wakeup dispatched",
    buildMissionOwnerDecisionWakeupDispatchedMarker({ missionId: input.missionId, ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.sourceIssueId, decision: "reassign_source_issue", idempotencyKey: input.idempotencyKey }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Target agent: ${input.targetAgentId}`, `Wakeup status: ${input.status}`, `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export async function applyReassignSourceIssueDecision(input: {
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
    await issueService(input.db).addComment(input.sourceIssue.id, buildReassignSourceIssueComment({
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
          buildReassignSourceIssueWakeupResultComment({ status: wakeupDispatchStatus, missionId: input.mission.id, ownerActionIssueId: input.ownerActionIssue.id, ownerActionLabel: input.ownerActionLabel, sourceIssueId: input.sourceIssue.id, sourceLabel, targetAgentId, idempotencyKey }),
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
