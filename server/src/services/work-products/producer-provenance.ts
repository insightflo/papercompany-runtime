import { eq } from "drizzle-orm";
import { heartbeatRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { lockProducerSelection } from "./producer-selection-lock.js";
import { conflict } from "../../errors.js";
import { producerAttempt } from "./producer-attempt.js";
import { delegatedProducer, type ProducerDelegation } from "./delegated-provenance.js";

/** Only DB-linked authenticated heartbeat identity may stamp producer provenance. */
export async function registeredProducer(db: Pick<Db, "select">, companyId: string, issueId: string,
  heartbeatId?: string | null, delegation?: ProducerDelegation | null) {
  if (!heartbeatId) return null;
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatId));
  if (!heartbeat || heartbeat.companyId !== companyId) throw conflict("workproduct_producer_scope_mismatch");
  if (delegation) return delegatedProducer(db, companyId, issueId, heartbeat, delegation);
  if (heartbeat.issueId !== issueId) throw conflict("workproduct_producer_scope_mismatch");
  if (!heartbeat.workflowStepRunId || heartbeat.workflowExecutionGeneration === null) return null;
  const [observed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heartbeat.workflowStepRunId));
  const locked = observed && await lockProducerSelection(db, { companyId, workflowRunId: observed.workflowRunId,
    stepRunIds: [heartbeat.workflowStepRunId] }, "share");
  const source = locked?.run && locked.steps[0] ? { run: locked.run, step: locked.steps[0] } : null;
  if (!source || source.step.issueId !== issueId || source.step.executionGeneration !== heartbeat.workflowExecutionGeneration) {
    throw conflict("workproduct_producer_stale_generation");
  }
  const attempt = await producerAttempt(db, heartbeat, source.step);
  return { schemaVersion: "workflow.work-product-producer.v1" as const, companyId, missionId: source.run.missionId,
    workflowRunId: source.run.id, stepRunId: source.step.id, stepId: source.step.stepId,
    executionGeneration: heartbeat.workflowExecutionGeneration, ...attempt, heartbeatRunId: heartbeat.id };
}

export function preserveProducerMetadata(metadata: Record<string, unknown> | null | undefined, producer: unknown) {
  const clean = { ...(metadata ?? {}) }; delete clean.workflowProducer;
  if (producer) clean.workflowProducer = producer;
  return clean;
}
