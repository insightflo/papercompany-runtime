import { isDeepStrictEqual as same } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getMetadataRecord } from "./dag-metadata-helpers.js";
import { deferredBeforeStartSchema, type DeferredBeforeStart } from "../runtime-execution-lifecycle.js";
import { admitClaimMetadataWithQaArtifactRequest } from "./deferred-claim-qa-delta.js";
import { withResumeSerialization } from "./resume/serialization.js";
import { type WorkflowToolCorrection, withWorkflowToolCorrection } from "./workflow-tool-correction.js";
import type { WorkflowStep } from "./dag-engine.js";

export async function releaseDeferredWorkflowToolClaim(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  step: WorkflowStep;
  claimedStepRun: typeof workflowStepRuns.$inferSelect;
  requestId: string;
  deferred: DeferredBeforeStart;
  correction: WorkflowToolCorrection | null;
}): Promise<boolean> {
  const parsed = deferredBeforeStartSchema.safeParse(input.deferred);
  if (!parsed.success
    || parsed.data.requestId !== input.requestId
    || parsed.data.executionId !== input.run.id
    || parsed.data.attemptId !== input.claimedStepRun.id
    || parsed.data.executionGeneration !== input.claimedStepRun.executionGeneration) {
    throw new DeferredWorkflowToolClaimScopeError("workflow_deferred_before_start_scope_mismatch");
  }

  const release = async (
    writer: Db,
    currentRun: typeof workflowRuns.$inferSelect,
    currentStep: typeof workflowStepRuns.$inferSelect | undefined,
  ): Promise<boolean> => {
    if (currentRun.id !== input.run.id || currentRun.companyId !== input.run.companyId
      || currentRun.status !== "running" || !currentStep
      || currentStep.workflowRunId !== currentRun.id || currentStep.stepId !== input.step.id
      || currentStep.status !== "running" || currentStep.lastDispatchErrorAt !== null
      || currentStep.lastDispatchRequestId !== input.requestId
      || currentStep.executionGeneration !== input.claimedStepRun.executionGeneration
      || currentStep.retryCount !== input.claimedStepRun.retryCount
      || currentStep.iterationIndex !== input.claimedStepRun.iterationIndex
      || currentStep.statusTransitionVersion !== input.claimedStepRun.statusTransitionVersion
      || !same(currentStep.lastDispatchAcceptedAt, input.claimedStepRun.lastDispatchAcceptedAt)) return false;
    // [P6 B/C release defect] Exact-authority QA preparation delta admission:
    // prepareQaArtifactRequest may write a new toolArtifactRequest for this very
    // claim AFTER the queue claim, so byte-equality with the claim-time snapshot
    // would wrongly hold every deferred QA release. Only that single added
    // same-request snapshot is admissible; replacements, removals, unknown keys
    // and unrelated drift still hold the claim (deferred-claim-qa-delta.ts).
    const releasedMetadata = admitClaimMetadataWithQaArtifactRequest(
      currentStep.metadata, input.claimedStepRun.metadata, {
        companyId: currentRun.companyId, missionId: currentRun.missionId,
        workflowRunId: currentRun.id, stepId: currentStep.stepId, stepRunId: currentStep.id,
        executionGeneration: currentStep.executionGeneration, retryCount: currentStep.retryCount,
        iterationIndex: currentStep.iterationIndex, requestId: input.requestId,
      });
    if (!releasedMetadata) return false;

    const metadata = releasedMetadata;
    const toolQueue: Record<string, unknown> = {
      ...getMetadataRecord(metadata, "toolQueue"), status: "queued",
    };
    const toolInvocation: Record<string, unknown> = {
      ...getMetadataRecord(metadata, "toolInvocation"),
    };
    if (toolQueue.claimedAt === undefined || toolInvocation.dispatchedAt === undefined
      || toolInvocation.requestId !== input.requestId) return false;
    delete toolQueue.claimedAt;
    delete toolInvocation.dispatchedAt;

    const rows = await writer.update(workflowStepRuns).set({
      lastDispatchAcceptedAt: null,
      metadata: { ...metadata, toolQueue, toolInvocation },
    }).where(and(
      eq(workflowStepRuns.id, currentStep.id),
      eq(workflowStepRuns.workflowRunId, currentRun.id),
      eq(workflowStepRuns.stepId, input.step.id),
      eq(workflowStepRuns.status, "running"),
      eq(workflowStepRuns.lastDispatchRequestId, input.requestId),
      eq(workflowStepRuns.lastDispatchAcceptedAt, currentStep.lastDispatchAcceptedAt!),
      isNull(workflowStepRuns.lastDispatchErrorAt),
      eq(workflowStepRuns.executionGeneration, currentStep.executionGeneration),
      eq(workflowStepRuns.retryCount, currentStep.retryCount),
      eq(workflowStepRuns.iterationIndex, currentStep.iterationIndex),
      eq(workflowStepRuns.metadata, currentStep.metadata),
    )).returning({ id: workflowStepRuns.id });
    return rows.length === 1;
  };

  if (input.correction) {
    return (await withWorkflowToolCorrection({ db: input.db, run: input.run,
      stepRun: input.claimedStepRun, step: input.step, correction: input.correction },
    async (writer) => release(writer, input.run, input.claimedStepRun))) === true;
  }
  if (input.run.missionId) {
    return await withResumeSerialization(input.db, {
      companyId: input.run.companyId, missionId: input.run.missionId, runId: input.run.id,
    }, async (lock) => release(lock.tx as unknown as Db, lock.run,
      lock.steps.find((candidate) => candidate.id === input.claimedStepRun.id)));
  }
  return input.db.transaction(async (tx) => {
    const [currentRun] = await tx.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, input.run.companyId),
    )).for("update");
    if (!currentRun) return false;
    const [currentStep] = await tx.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, input.claimedStepRun.id), eq(workflowStepRuns.workflowRunId, currentRun.id),
    )).for("update");
    return release(tx as unknown as Db, currentRun, currentStep);
  });
}

export class DeferredWorkflowToolClaimScopeError extends Error {}
