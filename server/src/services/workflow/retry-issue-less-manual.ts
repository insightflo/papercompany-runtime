import { and, eq, sql } from "drizzle-orm";
import { assertRunNotReplaced } from "./run-replacement-guard.js";
import { validateQaRebindCardApproval } from "./qa-rebind-card-contract.js";
import { missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { isRunReopenGuardEnabled, isRunRecoveryServiceEnabled } from "./run-reopen-guard-flag.js";
import { latestTerminalDecision, recoverTerminalRun } from "./run-recovery-authority.js";
import type { WorkflowExecutionResult } from "./types.js";
import { deliverAcceptedToolRecovery } from "./tool-recovery-delivery.js";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "./replacement-execution-safety.js";
import { validateToolRecoveryDecision } from "./tool-recovery-outcome.js";
import { claimQaRebindRecovery, completeQaRebindRecovery, validateQaRebindIntent,
  QaRebindRecoveryRejected, type QaRebindRecoveryIntent } from "./qa-rebind-recovery-intent.js";

export type ExpectedToolFailure = {
  stepRunId: string;
  authorityVersion: number;
  executionGeneration: number;
  dispatchRequestId: string | null;
  ownerDecision?: { ownerActionIssueId: string; decisionEventId: string };
};

export async function retryIssueLessToolWorkflowStepInternal<TStep>(input: {
  db: Db;
  companyId: string;
  runId: string;
  stepId: string;
  recoveryRequestReference?: string | null;
  expectedFailure?: ExpectedToolFailure;
  qaRebind?: QaRebindRecoveryIntent;
  /** Re-read structured owner intent under the mission/run/step locks; never prose. */
  validateIntent?: (tx: Db) => Promise<boolean>;
  loadWorkflowExecutionContext: (db: Db, runId: string) => Promise<{
    run: { id: string; companyId: string; startedAt: Date | null; status: string; dispatchAuthorityVersion: number };
    steps: TStep[];
    stepRuns: (typeof workflowStepRuns.$inferSelect)[];
  }>;
  isIssueLessToolStep: (step: TStep) => boolean;
  resetUnlaunchedTerminalStepRuns: (db: Db, rows: (typeof workflowStepRuns.$inferSelect)[]) => Promise<(typeof workflowStepRuns.$inferSelect)[]>;
  syncWorkflowRunState: (db: Db, runId: string) => Promise<WorkflowExecutionResult>;
}): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  if (input.qaRebind && !input.expectedFailure) return null;
  const rebindTarget = input.qaRebind ? { companyId: input.companyId, runId: input.runId,
    stepId: input.stepId, qaRebind: input.qaRebind } : null;
  // Compose the read-only intent hook; claiming belongs after the last rejection check below.
  const validateIntent = rebindTarget
    ? async (tx: Db) => (!input.validateIntent || await input.validateIntent(tx)) && await validateQaRebindIntent(tx, rebindTarget)
    : input.validateIntent;
  const observed = await input.loadWorkflowExecutionContext(input.db, input.runId);
  if (observed.run.companyId !== input.companyId) return null;
  const observedStep = observed.stepRuns.find((s) => s.stepId === input.stepId);
  if (!observedStep) return null;
  const expected = input.expectedFailure ?? {
    stepRunId: observedStep.id, authorityVersion: observed.run.dispatchAuthorityVersion,
    executionGeneration: observedStep.executionGeneration, dispatchRequestId: observedStep.lastDispatchRequestId,
  };
  const [scope] = await input.db.select({ missionId: workflowRuns.missionId }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)));
  if (!scope) return null;
  const committed = await input.db.transaction(async (tx) => {
    // Same lock order as mission cancellation/resume. A cancelled mission is never revived here.
    let ownerAgentId: string | null = null;
    if (scope.missionId) {
      const [mission] = await tx.select().from(missions).where(and(eq(missions.id, scope.missionId), eq(missions.companyId, input.companyId))).for("update");
      if (!mission || mission.status !== "active") return null;
      ownerAgentId = mission.ownerAgentId;
    }
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId))).for("update");
    if (!run || run.missionId !== scope.missionId || !["failed", "running"].includes(run.status)) return null;
    // Preserve the existing early denial order outside the new human-card path.
    if (!rebindTarget?.qaRebind.operatorDecisionId && run.dispatchAuthorityVersion !== expected.authorityVersion) return null;
    await assertRunNotReplaced(tx, run.id, input.companyId);
    const rows = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).orderBy(workflowStepRuns.id).for("update");
    // Card targets must be audited under the same locks even when ordinary stale-failure guards reject.
    if (rebindTarget?.qaRebind.operatorDecisionId
      && !await validateQaRebindCardApproval(tx as unknown as Db, rebindTarget, true)) return null;
    if (run.dispatchAuthorityVersion !== expected.authorityVersion) return null;
    if (input.expectedFailure && ((ownerAgentId && await replacementBudgetBlocked(tx as unknown as Db, input.companyId, ownerAgentId))
      || await replacementExecutionInFlight(tx as unknown as Db, input.companyId, run.id, rows))) return null;
    const stepRun = rows.find((s) => s.id === expected.stepRunId && s.stepId === input.stepId);
    if (!stepRun || stepRun.issueId || stepRun.status !== "failed"
      || stepRun.executionGeneration !== expected.executionGeneration
      || stepRun.lastDispatchRequestId !== expected.dispatchRequestId
      || stepRun.completedAt?.getTime() !== observedStep.completedAt?.getTime()) return null;
    const context = await input.loadWorkflowExecutionContext(tx as unknown as Db, run.id);
    const step = context.steps.find((s) => typeof s === "object" && s !== null && (s as { id?: string }).id === input.stepId);
    if (!step || !input.isIssueLessToolStep(step) || (validateIntent && !await validateIntent(tx as unknown as Db))) return null;
    const ownerDecision = input.expectedFailure?.ownerDecision;
    if (ownerDecision && !await validateToolRecoveryDecision(tx as unknown as Db, input.companyId, run.missionId, ownerDecision, expected, run.id)) return null;
    const strict = Boolean(input.expectedFailure);
    if (strict && (run.status !== "failed" || stepRun.metadata?.workflowRetryExhaustion)) return null;
    const guard = await isRunReopenGuardEnabled(tx as unknown as Db);
    const official = strict || await isRunRecoveryServiceEnabled(tx as unknown as Db);
    let authority: { id: string; resultingAuthorityVersion: number } | null = null;
    if (official && run.status === "failed") {
      const decision = await latestTerminalDecision(tx as unknown as Db, run.id, input.companyId);
      if (strict && (!decision || decision.decidedAuthorityVersion !== expected.authorityVersion || decision.decision !== "failed")) return null;
      if (decision) {
        if (decision.decidedAuthorityVersion !== expected.authorityVersion || decision.decision !== "failed") return null;
        if (rebindTarget) await claimQaRebindRecovery(tx as unknown as Db, rebindTarget);
        const recovered = await recoverTerminalRun(tx as unknown as Db, {
          runId: run.id, companyId: input.companyId, expectedAuthorityVersion: expected.authorityVersion,
          expectedDecision: "failed", recoveryKind: "supervision_tool_retry",
          requestReference: input.recoveryRequestReference ?? null, requestedBy: "mission_supervision", now: new Date(),
        });
        // A consumption receipt is not permission to reset, even with the same key.
        if (recovered.kind !== "recovered") {
          if (rebindTarget) throw new QaRebindRecoveryRejected();
          return null;
        }
        authority = recovered.authority;
        if (ownerDecision) await tx.update(workflowRecoveryAuthorities).set({ ownerDecisionEventId: ownerDecision.decisionEventId })
          .where(eq(workflowRecoveryAuthorities.id, authority.id));
      }
    }
    if (!authority) await tx.update(workflowRuns).set({ status: "running", completedAt: null,
      startedAt: run.startedAt ?? new Date(), ...(guard ? { dispatchAuthorityVersion: sql`${workflowRuns.dispatchAuthorityVersion} + 1` } : {}),
    }).where(eq(workflowRuns.id, run.id));
    const metadata = { ...(stepRun.metadata ?? {}) };
    for (const key of ["toolResult", "toolInvocation", "toolQueue", "cacheHit", "controlFlowSkipped", "ownerToolRetry"]) delete metadata[key];
    if (authority) metadata.ownerToolRetry = { schemaVersion: 1, authorityId: authority.id,
      authorityVersion: authority.resultingAuthorityVersion, executionGeneration: expected.executionGeneration + 1, ...ownerDecision };
    await tx.update(workflowStepRuns).set({ status: "pending", startedAt: null, completedAt: null,
      lastDispatchRequestId: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null, lastDispatchErrorSummary: null, metadata,
    }).where(eq(workflowStepRuns.id, stepRun.id));
    // Legacy reset behavior is preserved; explicit v2 recovery resets only the named tool.
    if (!strict) await input.resetUnlaunchedTerminalStepRuns(tx as unknown as Db, rows);
    if (rebindTarget) {
      if (!authority) throw new QaRebindRecoveryRejected();
      await completeQaRebindRecovery(tx as unknown as Db, rebindTarget, authority.id);
    }
    return { stepRunId: stepRun.id, official: Boolean(authority) };
  }).catch(error => {
    if (error instanceof QaRebindRecoveryRejected) return null;
    throw error;
  });
  if (!committed) return null;
  // Native sync owns the durable tool queue. A crash here leaves the exact authority-bound
  // pending receipt for the native reconciler, not permission to consume/reset again.
  const result = committed.official
    ? await deliverAcceptedToolRecovery(input.db, committed.stepRunId, input.syncWorkflowRunState)
    : await input.syncWorkflowRunState(input.db, input.runId);
  return result ? { stepRunId: committed.stepRunId, result } : null;
}
