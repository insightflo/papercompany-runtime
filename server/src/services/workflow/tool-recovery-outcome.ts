import { and, eq } from "drizzle-orm";
import { workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { loadLatestMissionOwnerDecision } from "../missions/mission-owner-recovery-ledger.js";

/** Persist only queue acceptance observed under the delivery mission/run/step locks. */
export async function recordAcceptedToolRecoveryOutcome(db: Db, run: typeof workflowRuns.$inferSelect,
  stepRunId: string, authority: typeof workflowRecoveryAuthorities.$inferSelect) {
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  const receipt = step?.metadata?.ownerToolRetry as Record<string, unknown> | undefined;
  const invocation = step?.metadata?.toolInvocation as Record<string, unknown> | undefined;
  const queue = step?.metadata?.toolQueue as Record<string, unknown> | undefined;
  if (!step || !receipt || typeof receipt.ownerActionIssueId !== "string" || typeof receipt.decisionEventId !== "string"
    || receipt.authorityId !== authority.id || receipt.decisionEventId !== authority.ownerDecisionEventId
    || !authority.requestReference || !step.lastDispatchRequestId
    || invocation?.requestId !== step.lastDispatchRequestId || !(step.lastDispatchAcceptedAt || queue?.status === "queued")) return null;
  // The accepted decision remains historical evidence if a newer decision is submitted later.
  const [decision] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, receipt.decisionEventId), eq(workflowTransitionEvents.companyId, run.companyId),
    eq(workflowTransitionEvents.issueId, receipt.ownerActionIssueId), eq(workflowTransitionEvents.eventType, "mission_owner_decision")));
  const target = decision?.payload?.recoveryTarget as Record<string, unknown> | undefined;
  if (!decision || decision.reason !== "owner_recovery_api" || decision.payload?.source !== "owner_recovery_api" || decision.missionId !== run.missionId
    || decision.decision !== "retry_source_issue" || target?.kind !== "tool_step" || target.workflowRunId !== run.id
    || target.stepRunId !== step.id || target.expectedAuthorityVersion !== authority.targetAuthorityVersion
    || target.expectedExecutionGeneration !== step.executionGeneration - 1) return null;
  const outcome = { schemaVersion: 1, kind: "retry_requested", outcome: "dispatched", reason: "dispatch_accepted",
    ownerActionIssueId: receipt.ownerActionIssueId, decisionEventId: decision.id, target,
    authorityId: authority.id, dispatchRequestId: step.lastDispatchRequestId };
  await db.insert(workflowTransitionEvents).values({ companyId: run.companyId, missionId: run.missionId,
    issueId: receipt.ownerActionIssueId, workflowRunId: run.id, workflowStepRunId: step.id,
    layer: "mission_owner_recovery", eventType: "mission_owner_tool_step_retry", decision: "retry_source_issue",
    fromStatus: "failed", toStatus: "running", reason: "owner_recovery_api", reasonCode: "owner_recovery_api",
    idempotencyKey: authority.requestReference, payload: { schema: "recovery_outcome.v1", ...outcome },
  }).onConflictDoNothing();
  return outcome;
}

export async function validateToolRecoveryDecision(db: Db, companyId: string, missionId: string | null,
  owner: { ownerActionIssueId: string; decisionEventId: string },
  target: { stepRunId: string; authorityVersion: number; executionGeneration: number; dispatchRequestId: string | null }, runId: string) {
  const current = await loadLatestMissionOwnerDecision({ db, companyId, ownerActionIssueId: owner.ownerActionIssueId });
  const t = current?.decision.recoveryTarget;
  return current?.eventId === owner.decisionEventId && current.missionId === missionId
    && current.decision.decision === "retry_source_issue" && t?.kind === "tool_step" && t.workflowRunId === runId
    && t.stepRunId === target.stepRunId && t.expectedAuthorityVersion === target.authorityVersion
    && t.expectedExecutionGeneration === target.executionGeneration && t.failedDispatchRequestId === target.dispatchRequestId;
}
