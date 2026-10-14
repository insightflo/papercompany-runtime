import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { ProducerRebindRequired, ProducerRebindIssuanceFailed } from "./automatic-producer-rebind.js";
import type { Db } from "@paperclipai/db";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "./workflow-sync-source.js";
import { isQaRebindConsumer, persistQaRebindCandidate } from "./qa-rebind-candidate.js";

type FailedToolDispatch = {
  db: Db; step: WorkflowStep; stepRun: typeof workflowStepRuns.$inferSelect; now: Date;
  requestId: string; toolName: string; args: unknown; error: unknown;
  provenance?: { run: Pick<typeof workflowRuns.$inferSelect, "id" | "companyId" | "missionId">; source: WorkflowSyncSource };
};

/** Typed rollback request carries the original failed dispatch, never reconstructed from error prose. */
export class DeferredProducerRebindDispatch extends ProducerRebindRequired {
  constructor(request: ProducerRebindRequired, private readonly input: FailedToolDispatch,
    private readonly baseMetadata: Record<string, unknown>) { super(request.scope); }
  get stepRunId() { return this.input.stepRun.id; }
  matchesStep(step: typeof workflowStepRuns.$inferSelect): boolean {
    const prior = this.input.stepRun.metadata?.ownerToolRetry as Record<string, unknown> | undefined;
    const current = step.metadata?.ownerToolRetry as Record<string, unknown> | undefined;
    return step.id === this.stepRunId && step.executionGeneration === this.input.stepRun.executionGeneration
      && !!prior && !!current && prior.authorityId === current.authorityId
      && prior.authorityVersion === current.authorityVersion && prior.executionGeneration === current.executionGeneration;
  }
  async persist(db: Db, error: ProducerRebindRequired | ProducerRebindIssuanceFailed): Promise<void> {
    await persistFailedToolDispatch({ ...this.input, db, error }, this.baseMetadata, false);
  }
}

/** Preserve the existing failure CAS/provenance, atomically append an observation after CAS wins. */
export async function persistFailedToolDispatch(input: FailedToolDispatch, baseMetadata: Record<string, unknown>,
  deferRebind = true): Promise<void> {
  if (deferRebind && input.error instanceof ProducerRebindRequired && is(input.db, PgTransaction)
    && input.stepRun.metadata?.ownerToolRetry) {
    throw new DeferredProducerRebindDispatch(input.error, input, baseMetadata);
  }
  const errorSummary = input.error instanceof Error ? input.error.message : String(input.error);
  const rebindDiagnostic = input.error instanceof ProducerRebindRequired || input.error instanceof ProducerRebindIssuanceFailed
    ? input.error.diagnostic : null;
  const metadata: Record<string, unknown> = { ...baseMetadata, toolInvocation: {
    requestId: input.requestId, toolName: input.toolName, args: input.args,
    dispatchedAt: input.now.toISOString(), dispatchError: errorSummary,
    ...(rebindDiagnostic ? { producerRebindDiagnostic: rebindDiagnostic } : {}),
  } };
  delete metadata.concurrencyBlocked;
  if (input.stepRun.lastDispatchRequestId !== input.requestId) delete metadata.artifactExecution;
  const observe = !!input.provenance && isQaRebindConsumer(input.stepRun.issueId, input.step, input.stepRun.metadata);
  const writeFailure = async (writer: Db) => {
    const updated = await setWorkflowStepRunStatus(writer, {
      stepRunId: input.stepRun.id, status: "failed", patch: {
        startedAt: input.stepRun.startedAt ?? input.now, completedAt: input.now,
        lastDispatchAttemptAt: input.now, lastDispatchErrorAt: input.now,
        lastDispatchErrorSummary: errorSummary, lastDispatchRequestId: input.requestId, metadata,
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
