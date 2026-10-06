import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "./workflow-sync-source.js";
import { isQaRebindConsumer, persistQaRebindCandidate } from "./qa-rebind-candidate.js";

type FailedToolDispatch = {
  db: Db; step: WorkflowStep; stepRun: typeof workflowStepRuns.$inferSelect; now: Date;
  requestId: string; toolName: string; args: unknown; error: string;
  provenance?: { run: Pick<typeof workflowRuns.$inferSelect, "id" | "companyId" | "missionId">; source: WorkflowSyncSource };
};

/** Preserve the existing failure CAS/provenance, atomically append an observation after CAS wins. */
export async function persistFailedToolDispatch(input: FailedToolDispatch, baseMetadata: Record<string, unknown>): Promise<void> {
  const metadata: Record<string, unknown> = { ...baseMetadata, toolInvocation: {
    requestId: input.requestId, toolName: input.toolName, args: input.args,
    dispatchedAt: input.now.toISOString(), dispatchError: input.error,
  } };
  delete metadata.concurrencyBlocked;
  if (input.stepRun.lastDispatchRequestId !== input.requestId) delete metadata.artifactExecution;
  const observe = !!input.provenance && isQaRebindConsumer(input.stepRun.issueId, input.step, input.stepRun.metadata);
  const writeFailure = async (writer: Db) => {
    const updated = await setWorkflowStepRunStatus(writer, {
      stepRunId: input.stepRun.id, status: "failed", patch: {
        startedAt: input.stepRun.startedAt ?? input.now, completedAt: input.now,
        lastDispatchAttemptAt: input.now, lastDispatchErrorAt: input.now,
        lastDispatchErrorSummary: input.error, lastDispatchRequestId: input.requestId, metadata,
      }, expectedStatuses: [input.stepRun.status],
    });
    if (!updated || !input.provenance) return;
    await recordWorkflowStepStatusTransition(writer, {
      companyId: input.provenance.run.companyId, missionId: input.provenance.run.missionId,
      workflowRunId: input.provenance.run.id, workflowStepRunId: input.stepRun.id, issueId: input.stepRun.issueId,
      fromStatus: input.stepRun.status, toStatus: "failed", source: input.provenance.source,
      transitionVersion: updated.statusTransitionVersion > input.stepRun.statusTransitionVersion ? updated.statusTransitionVersion : null,
    });
    if (observe) await persistQaRebindCandidate(writer, { companyId: input.provenance.run.companyId,
      workflowRunId: input.provenance.run.id, consumerStepRunId: updated.id });
  };
  if (observe && input.provenance) {
    const run = input.provenance.run;
    await input.db.transaction(async tx => {
      await lockFailureObservationScope(tx as unknown as Db, run);
      await writeFailure(tx as unknown as Db);
    });
  }
  else await writeFailure(input.db);
}

/**
 * Consumer-failure observation tx lock prelude. Global order mission → run → step: take the KEY SHARE
 * locks the FK checks (transition event → mission, candidate → run) need BEFORE the step UPDATE, so
 * the held step lock can't invert order against mission/run FOR UPDATE writers (finalize, strict retry).
 */
export async function lockFailureObservationScope(tx: Db, run: { id: string; companyId: string; missionId: string | null }) {
  if (run.missionId) await tx.select({ id: missions.id }).from(missions)
    .where(and(eq(missions.id, run.missionId), eq(missions.companyId, run.companyId))).for("key share");
  await tx.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, run.companyId))).for("key share");
}
