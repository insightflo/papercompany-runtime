import { and, eq, is, or } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { wakeExistingWorkflowStepIssue, type WorkflowStep } from "./dag-engine.js";
import { findAcceptedWorkflowResumeWakeForStep } from "../workflow-resume-wake.js";
import { createReplacementRootNotifications, currentReplacementRootNotifications,
  withReplacementRootNotificationDb } from "../issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "./replacement-agent-delivery.js";
import { logger } from "../../middleware/logger.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { latestTerminalDecision, recoverTerminalRun } from "./run-recovery-authority.js";
import { evaluateRecoveryChannels } from "./run-terminal-recovery-gate.js";
import { isRunRecoveryServiceEnabled } from "./run-reopen-guard-flag.js";
import { resumeWorkflowRun } from "./workflow-store.js";
import { HttpError } from "../../errors.js";
import type { AutomaticSourceRecovery } from "./source-issue-native-resume.js";
import { reviveAuthorizedFailureCascade } from "./failure-cascade-recovery.js";
import { loadLatestMissionOwnerDecision } from "../missions/mission-owner-recovery-ledger.js";
import { readExactOwnerRetryHumanWait } from "../missions/owner-retry-human-wait.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function acceptSourceIssueRecovery(db: Db, input: {
  run: typeof workflowRuns.$inferSelect; stepRunId: string; issueId: string;
  /** [owner automatic] exact failure + 현재 intent 검증 — legacy board resume fallback 미사용. */
  ownerExecution?: AutomaticSourceRecovery;
}) {
  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const run = await lockUnreplacedRun(t, input.run.id, input.run.companyId);
      if (!run || run.status !== "failed" || run.dispatchAuthorityVersion !== input.run.dispatchAuthorityVersion) return null;
      const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).for("update");
      const step = steps.find((s) => s.id === input.stepRunId && s.issueId === input.issueId);
      if (!step || step.status !== "failed") return null;
      let receipt: { authorityId: string; authorityVersion: number; executionGeneration: number } | null = null;
      if (input.ownerExecution) {
        const oe = input.ownerExecution;
        // exact failure identity + 현재 intent 를 같은 lock 하에서 재확인(상한 소진도 차단).
        if (run.id !== oe.workflowRunId || run.missionId !== oe.missionId || input.stepRunId !== oe.stepRunId
          || run.dispatchAuthorityVersion !== oe.expectedAuthorityVersion
          || step.executionGeneration !== oe.expectedExecutionGeneration
          || step.lastDispatchRequestId !== oe.failedDispatchRequestId
          || record(step.metadata).workflowRetryExhaustion || !await oe.validateIntent(t)) return null;
      }
      const serviceEnabled = await isRunRecoveryServiceEnabled(t);
      const decision = await latestTerminalDecision(t, run.id, run.companyId);
      if (input.ownerExecution && (!serviceEnabled || !decision)) return null; // no legacy fallback
      let official = false;
      if (serviceEnabled && decision) {
        if (decision.decidedAuthorityVersion !== run.dispatchAuthorityVersion) return null;
        const gate = await evaluateRecoveryChannels(t, { runId: run.id, companyId: run.companyId, missionId: run.missionId, stepRuns: steps, now: new Date() });
        if (gate.kind !== "open") return null;
        const recovery = await recoverTerminalRun(t, { runId: run.id, companyId: run.companyId,
          expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedDecision: "failed",
          recoveryKind: input.ownerExecution ? "supervision_tool_retry" : "source_issue_unblock",
          requestReference: input.ownerExecution ? `mission-owner-execute:${input.ownerExecution.actionId}` : input.issueId,
          requestedBy: input.ownerExecution ? "mission_owner_execute" : "source_issue_unblock", now: new Date() });
        if (recovery.kind !== "recovered") return null;
        await reviveAuthorizedFailureCascade(t, { observedRun: run, failedStep: step, authority: recovery.authority });
        official = true;
        if (input.ownerExecution) receipt = { authorityId: recovery.authority.id,
          authorityVersion: recovery.authority.resultingAuthorityVersion,
          executionGeneration: input.ownerExecution.expectedExecutionGeneration + 1 };
      } else if (!await resumeWorkflowRun(t, run.id, run.companyId)) return null;
      const [changed] = await tx.update(workflowStepRuns).set({ status: "running", completedAt: null,
        ...(receipt ? { metadata: { ...record(step.metadata), ownerToolRetry: { schemaVersion: 1, ...receipt } } } : {}) })
        .where(and(eq(workflowStepRuns.id, step.id), eq(workflowStepRuns.status, "failed"))).returning();
      if (!changed) throw new Error("source_issue_recovery_cas_lost");
      const [updated] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
      return { run: updated, official };
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return null;
    throw error;
  }
}

type SourceResumeInput = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  issueId: string;
  allowBlockedIssue: boolean;
  wakeFn?: typeof wakeExistingWorkflowStepIssue;
  ownerExecution?: AutomaticSourceRecovery;
  ownerAction?: { ownerActionIssueId: string; missionId: string; decisionCommentId: string };
};

async function ownerActionResumeIsCurrent(tx: Db, input: Pick<SourceResumeInput, "run" | "issueId" | "ownerAction">): Promise<boolean> {
  const action = input.ownerAction, missionId = input.run.missionId;
  if (!action || !missionId || action.missionId !== missionId) return false;
  const [mission] = await tx.select({ ownerAgentId: missions.ownerAgentId }).from(missions).where(and(
    eq(missions.id, missionId), eq(missions.companyId, input.run.companyId)));
  const [anchor] = await tx.select({ id: issues.id, originKind: issues.originKind, originId: issues.originId,
    missionId: issues.missionId, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(
    eq(issues.id, action.ownerActionIssueId), eq(issues.companyId, input.run.companyId)));
  if (!mission?.ownerAgentId || !anchor || anchor.missionId !== missionId
    || anchor.originKind !== "mission_main_executor_unblock" || !anchor.originId
    || anchor.assigneeAgentId !== mission.ownerAgentId) return false;
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, anchor.originId),
    eq(issues.companyId, input.run.companyId), eq(issues.missionId, missionId)));
  const [target] = await tx.select({ id: issues.id, hiddenAt: issues.hiddenAt }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.run.companyId), eq(issues.missionId, missionId)));
  if (!source || !target || target.hiddenAt) return false;

  const latest = await loadLatestMissionOwnerDecision({ db: tx, companyId: input.run.companyId,
    missionId, ownerActionIssueId: action.ownerActionIssueId });
  if (!action.decisionCommentId) {
    const wait = await readExactOwnerRetryHumanWait(tx, { companyId: input.run.companyId, missionId,
      ownerActionIssueId: action.ownerActionIssueId, originalSourceIssueId: source.id, retryIssueId: target.id });
    return latest === null && wait.kind === "clear";
  }
  if (!latest || latest.eventId !== action.decisionCommentId || latest.ownerActionIssueId !== action.ownerActionIssueId
    || latest.missionId !== missionId || latest.authorAgentId !== mission.ownerAgentId
    || latest.decision.decision !== "retry_source_issue"
    || (latest.sourceIssueId !== source.id && latest.sourceIssueId !== target.id)) return false;
  const decision = latest.decision;
  const refMatches = async (ref: string) => {
    const matches = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, input.run.companyId), eq(issues.missionId, missionId),
      or(eq(issues.id, ref), eq(issues.identifier, ref)))).limit(2);
    return matches.length === 1 && matches[0]!.id === target.id;
  };
  if (decision.recoveryTarget) {
    if (decision.recoveryTarget.kind !== "issue" || decision.recoveryTarget.issueId !== target.id) return false;
    for (const ref of [decision.reworkTargetRef, decision.sourceIssueRef]) {
      if (ref && !await refMatches(ref)) return false;
    }
    return true;
  }
  const ref = decision.reworkTargetRef ?? decision.sourceIssueRef;
  return typeof ref === "string" && await refMatches(ref);
}

/** Recovery and its exact native request commit together. Queue booleans are not receipts. */
export async function queueSourceIssueResume(db: Db, input: SourceResumeInput): Promise<boolean> {
  const enqueue = async (t: Db, run: typeof workflowRuns.$inferSelect, stepRun: typeof workflowStepRuns.$inferSelect) => {
    const scope = { companyId: run.companyId, issueId: input.issueId,
      workflowRunId: run.id, workflowStepRunId: input.stepRun.id };
    const existingIds = new Set((await t.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.issueId, scope.issueId),
        eq(agentWakeupRequests.workflowRunId, scope.workflowRunId),
        eq(agentWakeupRequests.workflowStepRunId, scope.workflowStepRunId),
        eq(agentWakeupRequests.requestKind, "workflow_resume")))).map(row => row.id));
    const oe = input.ownerExecution;
    const queued = await (input.wakeFn ?? wakeExistingWorkflowStepIssue)({
      db: t, run, definition: input.definition, step: input.step,
      stepRunId: stepRun.id, stepRunMetadata: stepRun.metadata,
      issueId: input.issueId, allowBlockedIssue: input.allowBlockedIssue,
      requireOwnWake: true,
      ...(oe ? { ownerExecution: { schemaVersion: 1 as const, actionId: oe.actionId,
        expectedAuthorityVersion: input.run.status === "failed" ? run.dispatchAuthorityVersion : oe.expectedAuthorityVersion,
        expectedExecutionGeneration: oe.expectedExecutionGeneration + (input.run.status === "failed" ? 1 : 0) } } : {}),
    });
    const accepted = (await findAcceptedWorkflowResumeWakeForStep(t, scope)).filter(row => !existingIds.has(row.id));
    if (!queued || accepted.length !== 1) throw new Error("source_issue_resume_wake_rejected");
    // The shared liveness reader also sees other request kinds. Validate the stored typed kind.
    const [wake] = await t.select({ requestKind: agentWakeupRequests.requestKind }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, accepted[0]!.id));
    if (wake?.requestKind !== "workflow_resume") throw new Error("source_issue_resume_wake_rejected");
  };
  if (input.ownerAction && input.ownerExecution) return false;
  const ownsDrain = !is(db, PgTransaction);
  const notifications = currentReplacementRootNotifications(db) ?? createReplacementRootNotifications();
  let accepted = false;
  try {
    accepted = await db.transaction(async tx => {
      const t = tx as unknown as Db;
      return withReplacementRootNotificationDb(t, notifications, async () => {
        const run = await lockUnreplacedRun(t, input.run.id, input.run.companyId);
        if (!run || run.status !== input.run.status || run.workflowId !== input.run.workflowId
          || run.missionId !== input.run.missionId || run.dispatchAuthorityVersion !== input.run.dispatchAuthorityVersion
          || input.definition.id !== run.workflowId || input.definition.companyId !== run.companyId) return false;
        const [stepRun] = await tx.select().from(workflowStepRuns).where(and(
          eq(workflowStepRuns.id, input.stepRun.id), eq(workflowStepRuns.workflowRunId, run.id))).for("update");
        if (!stepRun || stepRun.issueId !== input.issueId || stepRun.stepId !== input.stepRun.stepId
          || stepRun.status !== input.stepRun.status || stepRun.executionGeneration !== input.stepRun.executionGeneration
          || stepRun.lastDispatchRequestId !== input.stepRun.lastDispatchRequestId || input.step.id !== stepRun.stepId) return false;
        const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId),
          eq(issues.companyId, run.companyId), ...(run.missionId ? [eq(issues.missionId, run.missionId)] : [])));
        if (!issue) return false;
        if (input.ownerAction && !await ownerActionResumeIsCurrent(t, { run, issueId: input.issueId, ownerAction: input.ownerAction })) return false;
        const oe = input.ownerExecution;
        if (oe && (run.id !== oe.workflowRunId || run.missionId !== oe.missionId || stepRun.id !== oe.stepRunId
          || run.dispatchAuthorityVersion !== oe.expectedAuthorityVersion
          || stepRun.executionGeneration !== oe.expectedExecutionGeneration
          || stepRun.lastDispatchRequestId !== oe.failedDispatchRequestId || !await oe.validateIntent(t))) return false;
        if (run.status === "failed") {
          if (stepRun.status !== "failed") return false;
          const recovery = await acceptSourceIssueRecovery(t, { run, stepRunId: stepRun.id, issueId: input.issueId,
            ...(oe ? { ownerExecution: oe } : {}) });
          if (!recovery) return false;
          await enqueue(t, recovery.run, stepRun);
        } else if (run.status === "running") {
          await enqueue(t, run, stepRun);
        } else return false;
        return true;
      });
    });
  } catch {
    // Never restore just the status after authority consumption: abort the entire transaction.
    return false;
  }
  if (accepted && ownsDrain) {
    try { await drainReplacementRootNotifications(db, notifications); }
    catch (err) {
      // Acceptance is already committed. The native heartbeat scheduler re-reads the same rows.
      logger.warn({ err, workflowRunId: input.run.id }, "source issue resume delivery deferred");
    }
  }
  return accepted;
}
