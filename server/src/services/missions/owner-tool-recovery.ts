import { and, eq, or, sql } from "drizzle-orm";
import { issues, missions, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { completeWorkflowToolStepFromResult, retryIssueLessToolWorkflowStep } from "../workflow/dag-engine.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { loadAuthorizedNativeToolStepRecovery } from "./tool-step-recovery-result.js";
import { evaluateOwnerToolRecoverySnapshot, loadBoundOwnerToolSourceState, toolRecoveryDecisionEffect } from "./owner-tool-recovery-eligibility.js";
import type { MissionSupervisionIssue, MissionSupervisionMission, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import type { MissionOwnerSupervisionAppliedAction } from "./supervision-types.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";

export type OwnerToolRecoveryOutcome = {
  schemaVersion: 1;
  kind: "no_op" | "retry_requested" | "artifact_recovered";
  outcome: "dispatched" | "already_in_flight" | "requires_decision" | "blocked";
  reason: string;
  ownerActionIssueId: string;
  decisionEventId: string | null;
  target: OwnerRecoveryTarget | null;
  dispatchRequestId?: string;
  authorityId?: string;
};

// Exact identity only. A description marker or a lone failed step is never a target.
export async function applyOwnerToolRecovery(input: {
  db: Db;
  mission: MissionSupervisionMission;
  issue: MissionSupervisionIssue;
  sourceIssue: MissionSupervisionIssue | null;
  stepRows: MissionSupervisionWorkflowStepRow[];
  apply: boolean;
}): Promise<{ outcome: OwnerToolRecoveryOutcome; appliedAction?: MissionOwnerSupervisionAppliedAction } | null> {
  const { db, mission, issue } = input;
  const decision = await loadLatestMissionOwnerDecision({ db, companyId: mission.companyId, ownerActionIssueId: issue.id });
  const target = decision?.decision.recoveryTarget ?? null;
  const base = { schemaVersion: 1 as const, ownerActionIssueId: issue.id, decisionEventId: decision?.eventId ?? null, target };
  const noOp = (reason: string, outcome: OwnerToolRecoveryOutcome["outcome"] = "blocked") => ({
    outcome: { ...base, kind: "no_op" as const, outcome, reason },
  });
  // Include damaged and cross-scope identity rows so they hold closed instead of looking absent.
  const identityRows = await db.select().from(workflowTransitionEvents).where(or(
    eq(workflowTransitionEvents.issueId, issue.id),
    sql`${workflowTransitionEvents.payload}->>'anchorIssueId' = ${issue.id}`));
  const toolLinks = identityRows.filter((link) => {
    const payload = link.payload && typeof link.payload === "object" && !Array.isArray(link.payload)
      ? link.payload as Record<string, unknown> : {};
    return link.eventType === "owner_tool_recovery_target_v1" || payload.kind === "tool_step"
      || link.idempotencyKey?.startsWith("owner-tool-card:") === true;
  });
  const toolCard = toolLinks.length > 0;
  const qaCard = identityRows.some((link) => link.companyId === mission.companyId && link.missionId === mission.id
    && link.eventType === "qa_cap_oversight_claim");
  if (toolCard) {
    if (toolLinks.length !== 1 || toolLinks.some(link => link.companyId !== mission.companyId
      || link.missionId !== mission.id || link.issueId !== issue.id)) return noOp("source_binding_ambiguous");
    const source = await loadBoundOwnerToolSourceState({ ...input, decision });
    if (source.kind === "held") return noOp(source.reason);
    if (source.kind === "source_recovered") return noOp("source_already_recovered");
  }
  const eligibility = evaluateOwnerToolRecoverySnapshot({ ...input, decision, toolCard, qaCard });
  if (eligibility.kind === "not_applicable") return null;
  if (eligibility.kind === "blocked") return noOp(eligibility.reason, eligibility.outcome);
  // Narrowing only: the shared guard already proves these identities.
  if (!decision || target?.kind !== "tool_step") return noOp("target_missing", "requires_decision");
  const row = eligibility.row;

  // A blocked result keeps supervision moving without falling through to generic issue retry.
  try {
    const retryKey = `mission-native-tool-step-retry:${mission.id}:${issue.id}:${row.run.id}:${row.stepRun.stepId}`;
    const [previous] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, mission.companyId), eq(workflowTransitionEvents.idempotencyKey, retryKey))).limit(1);
    if (previous) return noOp("retry_key_consumed", "requires_decision");
    if (toolRecoveryDecisionEffect(decision.decision.decision) === "artifact") {
      const evidence = await loadAuthorizedNativeToolStepRecovery({ db, companyId: mission.companyId,
        missionId: mission.id, missionOwnerAgentId: mission.ownerAgentId, ownerActionIssue: issue, sourceIssue: input.sourceIssue });
      if (!evidence) return noOp("missing_artifact", "requires_decision");
      const result = await completeWorkflowToolStepFromResult(db, {
        companyId: mission.companyId, stepRunId: row.stepRun.id, workflowRunId: row.run.id,
        stepId: row.stepRun.stepId, success: true, artifactPath: evidence.artifactPath,
        ...(target.failedDispatchRequestId ? { requestId: target.failedDispatchRequestId } : {}),
        stdout: `Recovered from registered workProduct ${evidence.workProductId}`, allowTerminalRecovery: true,
      });
      const [completed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, row.stepRun.id));
      const toolResult = completed?.metadata?.toolResult as Record<string, unknown> | undefined;
      if (!result || completed?.status !== "completed" || completed.executionGeneration !== target.expectedExecutionGeneration
        || toolResult?.recoveredBy !== "owner-action" || toolResult?.artifactPath !== evidence.artifactPath
        || toolResult?.requestId !== target.failedDispatchRequestId) return noOp("recovery_not_applied");
      return { outcome: { ...base, kind: "artifact_recovered", outcome: "requires_decision", reason: "artifact_recovered_no_dispatch_claim" },
        appliedAction: { type: "native_tool_step_recovery_result", missionId: mission.id,
          ownerActionIssueId: issue.id, workflowRunId: row.run.id, stepId: row.stepRun.stepId,
          stepRunId: row.stepRun.id, artifactPath: evidence.artifactPath, resultStatus: result.status } };
    }
    if (toolRecoveryDecisionEffect(decision.decision.decision) !== "retry") return noOp("retry_not_requested", "requires_decision");
    // Explicit owner intent + current failure + existing consumption ledger, in one transaction.
    const retry = await retryIssueLessToolWorkflowStep(db, { companyId: mission.companyId,
      runId: target.workflowRunId, stepId: row.stepRun.stepId, recoveryRequestReference: retryKey,
      expectedFailure: { stepRunId: target.stepRunId, authorityVersion: target.expectedAuthorityVersion,
        executionGeneration: target.expectedExecutionGeneration, dispatchRequestId: target.failedDispatchRequestId,
        ownerDecision: { ownerActionIssueId: issue.id, decisionEventId: decision.eventId } },
      validateIntent: async (tx) => {
        const [currentMission] = await tx.select().from(missions).where(eq(missions.id, mission.id));
        const [card] = await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
        const current = await loadLatestMissionOwnerDecision({ db: tx, companyId: mission.companyId, ownerActionIssueId: issue.id });
        return current?.eventId === decision.eventId && current.authorAgentId === currentMission?.ownerAgentId
          && current.missionId === mission.id && card?.companyId === mission.companyId && card.missionId === mission.id
          && card.originId === decision.sourceIssueId && !card.hiddenAt && card.status !== "cancelled";
      },
    });
    if (!retry) return noOp("retry_not_applied");
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, row.stepRun.id));
    const queue = after?.metadata?.toolQueue as { status?: unknown } | undefined;
    const invocation = after?.metadata?.toolInvocation as { requestId?: unknown } | undefined;
    const dispatched = Boolean(after?.lastDispatchRequestId && invocation?.requestId === after.lastDispatchRequestId
      && (after.lastDispatchAcceptedAt || queue?.status === "queued"));
    const receipt = after?.metadata?.ownerToolRetry as { authorityId?: string } | undefined;
    const outcome: OwnerToolRecoveryOutcome = { ...base, kind: "retry_requested",
      outcome: dispatched ? "dispatched" : "blocked", reason: dispatched ? "dispatch_accepted" : "dispatch_unconfirmed",
      ...(receipt?.authorityId ? { authorityId: receipt.authorityId } : {}),
      ...(dispatched ? { dispatchRequestId: after!.lastDispatchRequestId! } : {}) };
    return { outcome, appliedAction: { type: "native_tool_step_retry", missionId: mission.id,
      ownerActionIssueId: issue.id, workflowRunId: row.run.id, stepId: row.stepRun.stepId,
      stepRunId: retry.stepRunId, resultStatus: retry.result.status } };
  } catch {
    return noOp(toolRecoveryDecisionEffect(decision.decision.decision) === "artifact"
      ? "artifact_recovery_failed" : "tool_retry_failed");
  }
}
