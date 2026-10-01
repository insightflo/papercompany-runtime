import { and, eq, inArray } from "drizzle-orm";
import { workflowRunSeeds, workflowStepRuns, workflowStepOutputBindings, workflowTransitionEvents, issueWorkProducts, type Db } from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { workflowSeedEvidenceSchema } from "@paperclipai/shared/validators/workflow-seed";
import { lockProducerSelection } from "../work-products/producer-selection-lock.js";
import { logActivity } from "../activity-log.js";
import { appendWorkflowAuthorityTransition } from "./authority/transitions.js";

type StepRun = typeof workflowStepRuns.$inferSelect;
type ReworkInput = { db: Db; run: { id: string; companyId: string }; stepRuns: StepRun[] };
const reason = "seed_producer_native_rework";
const key = (s: StepRun) => `seed-rework:${s.id}:${s.executionGeneration}:${s.retryCount}:${s.iterationIndex}`;
const attemptIdentity = (s: StepRun) => ({ stepRunId: s.id, executionGeneration: s.executionGeneration,
  retryCount: s.retryCount, iterationIndex: s.iterationIndex, requestId: s.lastDispatchRequestId, status: s.status });

export function withSeedProducerRework<T extends { db: Db; companyId: string; stepRun: StepRun }, R>(reset: (input: T) => Promise<R>) {
  return async (input: T): Promise<R> => withSeedReworkBindings(async (context: ReworkInput) => {
    const current = context.stepRuns.find(s => s.id === input.stepRun.id);
    if (!current || current.status !== input.stepRun.status || current.executionGeneration !== input.stepRun.executionGeneration
      || current.iterationIndex !== input.stepRun.iterationIndex || current.retryCount !== input.stepRun.retryCount
      || current.lastDispatchRequestId !== input.stepRun.lastDispatchRequestId
      || current.completedAt?.getTime() !== input.stepRun.completedAt?.getTime()) throw new Error("seed_rework_attempt_changed");
    return reset({ ...input, db: context.db, stepRun: current });
  })({ db: input.db, run: { id: input.stepRun.workflowRunId, companyId: input.companyId }, stepRuns: [input.stepRun] });
}

/** Only native bounded loop passes call this wrapper. No status/prose-based selector fallback.
 * A run lock serializes reset, registration and typed selection; old pins are archived atomically
 * with consumer invalidation. The next selection still must prove a current official producer.
 */
export function withSeedReworkBindings<T extends ReworkInput, R>(pass: (input: T) => Promise<R>) {
  return async (input: T): Promise<R> => {
    const seeds = await input.db.select().from(workflowRunSeeds).where(and(
      eq(workflowRunSeeds.companyId, input.run.companyId), eq(workflowRunSeeds.targetRunId, input.run.id)));
    if (seeds.length === 0) return pass(input); // ordinary execution semantics unchanged
    return input.db.transaction(async tx => {
      const all = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.run.id));
      const locked = await lockProducerSelection(tx, { companyId: input.run.companyId, workflowRunId: input.run.id,
        stepRunIds: all.map(s => s.id) }, "update");
      if (!locked.run) throw new Error("seed_rework_run_missing");
      const before = new Map(locked.steps.map(s => [s.id, s]));
      const result = await pass({ ...input, run: { ...input.run, ...locked.run }, db: tx as unknown as Db, stepRuns: locked.steps });
      const after = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.run.id));
      const seededIds = new Set(seeds.map(s => s.targetStepRunId));
      for (const producer of after) {
        const prior = before.get(producer.id);
        if (!prior || !seededIds.has(producer.id) || producer.iterationIndex !== prior.iterationIndex + 1) continue;
        await appendWorkflowAuthorityTransition(tx, { companyId: input.run.companyId, workflowRunId: input.run.id,
          workflowStepRunId: producer.id, executionGeneration: producer.executionGeneration,
          reason, idempotencyKey: key(producer), payload: { version: 1, transition: reason,
            stepRunId: producer.id, executionGeneration: producer.executionGeneration,
            retryCount: producer.retryCount, iterationIndex: producer.iterationIndex } });
      }
      const invalidated = after.filter(s => {
        const prior = before.get(s.id);
        return prior && ["completed", "failed", "skipped"].includes(prior.status)
          && s.status === "pending" && s.lastDispatchRequestId === null;
      });
      if (!invalidated.length) return result;
      const bindings = await tx.select().from(workflowStepOutputBindings).where(and(
        eq(workflowStepOutputBindings.companyId, input.run.companyId), eq(workflowStepOutputBindings.workflowRunId, input.run.id),
        inArray(workflowStepOutputBindings.consumerStepRunId, invalidated.map(s => s.id))));
      for (const binding of bindings) {
        const producer = after.find(s => s.stepId === binding.referencedStepId && seededIds.has(s.id));
        if (!producer || producer.iterationIndex < 1) continue;
        const seed = seeds.find(s => s.targetStepRunId === producer.id)!;
        const evidence = workflowSeedEvidenceSchema.safeParse(seed.evidence);
        const [product] = await tx.select().from(issueWorkProducts).where(and(
          eq(issueWorkProducts.companyId, input.run.companyId), eq(issueWorkProducts.id, binding.workProductId)));
        const old = workProductProducerSchema.safeParse(product?.metadata?.workflowProducer);
        // Only the approved seed or an earlier official attempt can lose authority here.
        // Do not erase a current-attempt pin or disguise a foreign/corrupt binding as rework.
        const wasSeed = evidence.success && evidence.data.products.some(p => p.id === binding.workProductId);
        const wasEarlierAttempt = old.success && old.data.companyId === input.run.companyId
          && old.data.workflowRunId === input.run.id && old.data.stepRunId === producer.id
          && old.data.iterationIndex < producer.iterationIndex;
        if (!wasSeed && !wasEarlierAttempt) continue;
        const [proof] = await tx.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, input.run.companyId), eq(workflowTransitionEvents.workflowRunId, input.run.id),
          eq(workflowTransitionEvents.workflowStepRunId, producer.id), eq(workflowTransitionEvents.reasonCode, reason),
          eq(workflowTransitionEvents.idempotencyKey, key(producer))));
        if (!proof || proof.payload.version !== 1 || proof.payload.transition !== reason
          || proof.payload.stepRunId !== producer.id || proof.payload.executionGeneration !== producer.executionGeneration
          || proof.payload.retryCount !== producer.retryCount || proof.payload.iterationIndex !== producer.iterationIndex) continue;
        await logActivity(tx as unknown as Db, { companyId: input.run.companyId, actorType: "system", actorId: "workflow:seed-rework",
          action: "workflow.output_binding_retired", entityType: "workflow_step_run", entityId: binding.consumerStepRunId,
          details: { version: 1, reason: "native_consumer_invalidation", binding,
            consumerBefore: attemptIdentity(before.get(binding.consumerStepRunId)!),
            consumerAfter: attemptIdentity(invalidated.find(s => s.id === binding.consumerStepRunId)!),
            producerAttempt: proof.payload } });
        await tx.delete(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, binding.id));
      }
      return result;
    });
  };
}
