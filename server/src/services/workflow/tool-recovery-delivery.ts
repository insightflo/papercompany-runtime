import { and, eq } from "drizzle-orm";
import { missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import type { WorkflowExecutionResult } from "./types.js";
import { assertRunNotReplaced } from "./run-replacement-guard.js";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "./replacement-execution-safety.js";
import { recordAcceptedToolRecoveryOutcome } from "./tool-recovery-outcome.js";

/** Delivery of one accepted reset, never a new authorization or reset. */
export async function deliverAcceptedToolRecovery(db: Db, stepRunId: string,
  sync: (db: Db, runId: string) => Promise<WorkflowExecutionResult>): Promise<WorkflowExecutionResult | null> {
  const [scope] = await db.select({ run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(eq(workflowStepRuns.id, stepRunId));
  if (!scope) return null;
  return db.transaction(async (tx) => {
    let ownerAgentId: string | null = null;
    if (scope.run.missionId) {
      const [mission] = await tx.select().from(missions).where(and(eq(missions.id, scope.run.missionId), eq(missions.companyId, scope.run.companyId))).for("update");
      if (!mission || mission.status !== "active") return null;
      ownerAgentId = mission.ownerAgentId;
    }
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, scope.run.id)).for("update");
    if (!run || run.status !== "running" || run.missionId !== scope.run.missionId) return null;
    await assertRunNotReplaced(tx, run.id, run.companyId);
    const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).orderBy(workflowStepRuns.id).for("update");
    if ((ownerAgentId && await replacementBudgetBlocked(tx as unknown as Db, run.companyId, ownerAgentId))
      || await replacementExecutionInFlight(tx as unknown as Db, run.companyId, run.id, steps)) return null;
    const step = steps.find((s) => s.id === stepRunId);
    const receipt = step?.metadata?.ownerToolRetry as Record<string, unknown> | undefined;
    if (!step || step.status !== "pending" || step.issueId || step.lastDispatchRequestId || !receipt
      || receipt.schemaVersion !== 1 || typeof receipt.authorityId !== "string"
      || receipt.authorityVersion !== run.dispatchAuthorityVersion || receipt.executionGeneration !== step.executionGeneration) return null;
    const [authority] = await tx.select().from(workflowRecoveryAuthorities).where(and(
      eq(workflowRecoveryAuthorities.id, receipt.authorityId), eq(workflowRecoveryAuthorities.companyId, run.companyId),
      eq(workflowRecoveryAuthorities.workflowRunId, run.id), eq(workflowRecoveryAuthorities.status, "consumed"),
      eq(workflowRecoveryAuthorities.recoveryKind, "supervision_tool_retry"),
      eq(workflowRecoveryAuthorities.resultingAuthorityVersion, run.dispatchAuthorityVersion)));
    if (!authority) return null;
    // Native queue write and cancellation serialize on the same mission/run locks.
    // The executor is not called here: sync materializes the durable toolInvocation/toolQueue.
    const result = await sync(tx as unknown as Db, run.id);
    await recordAcceptedToolRecoveryOutcome(tx as unknown as Db, run, step.id, authority);
    return result;
  });
}

export async function reconcileAcceptedToolRecoveries(db: Db,
  sync: (db: Db, runId: string) => Promise<WorkflowExecutionResult>): Promise<void> {
  const candidates = await db.select({ id: workflowStepRuns.id, metadata: workflowStepRuns.metadata }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.status, "pending"), eq(workflowRuns.status, "running")));
  for (const step of candidates) {
    if (!step.metadata?.ownerToolRetry) continue;
    // Failure keeps the accepted receipt pending for the next native pass.
    try { await deliverAcceptedToolRecovery(db, step.id, sync); } catch { /* durable pending receipt retained */ }
  }
}
