import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { agentWakeupRequests, heartbeatRuns, qualityActions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { nativeBindingSchema, qualityTargetSchema } from "@paperclipai/shared";
import { parseQualityWakeKey, qualityWakeKey } from "../quality/native-wake.js";
import { conflict } from "../../errors.js";

// Exact server-owned admission record emitted by buildQualityWakeAcceptancePatch.
const acceptanceSchema = z.object({
  intentKey: z.string(), inputHash: z.string(), issueId: z.string().uuid(), stepRunId: z.string().uuid(),
  workflowRunId: z.string().uuid(), generation: z.number().int().nonnegative(), agentId: z.string().uuid(),
  attempt: z.number().int().positive(), acceptedAt: z.string().datetime(), heartbeatRunId: z.string().uuid(),
}).strict();
const retryPayloadSchema = z.object({
  stepRunId: z.string().uuid(), retryNumber: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(), delaySeconds: z.number().nonnegative(),
}).strict();

/** Bind the original quality wake to its admission and the retry ledger that existed at request time.
 * Quality aN counts deliveries within a generation, NOT generic retries; generation also advances for
 * other resets. Neither number nor the current step retryCount can stand in for the retry ledger.
 */
export async function qualityProducerRetryCount(db: Pick<Db, "select">,
  wake: typeof agentWakeupRequests.$inferSelect, heartbeat: typeof heartbeatRuns.$inferSelect,
  step: typeof workflowStepRuns.$inferSelect): Promise<number> {
  const reject = () => { throw conflict("workproduct_producer_attempt_unproven"); };
  const key = parseQualityWakeKey(wake.idempotencyKey);
  if (!key || !z.string().uuid().safeParse(key.actionId).success
    || !Number.isSafeInteger(key.generation) || !Number.isSafeInteger(key.attempt)
    || key.generation < 0 || key.attempt < 1 || qualityWakeKey(key) !== wake.idempotencyKey
    || key.stepRunId !== step.id || key.generation !== step.executionGeneration
    || key.generation !== heartbeat.workflowExecutionGeneration || wake.status === "coalesced") return reject();
  const receipt = acceptanceSchema.safeParse(wake.qualityAcceptance);
  if (!receipt.success) return reject();
  const a = receipt.data;
  if (a.issueId !== heartbeat.issueId || a.stepRunId !== step.id || a.workflowRunId !== step.workflowRunId
    || a.generation !== key.generation || a.attempt !== key.attempt || a.agentId !== heartbeat.agentId
    || a.heartbeatRunId !== heartbeat.id) return reject();
  const [action] = await db.select().from(qualityActions).where(and(
    eq(qualityActions.companyId, heartbeat.companyId), eq(qualityActions.id, key.actionId)));
  const binding = nativeBindingSchema.safeParse(action?.canonicalBinding);
  const target = qualityTargetSchema.safeParse(action?.target);
  if (!action || !binding.success || !target.success) return reject();
  const b = binding.data;
  if (b.companyId !== heartbeat.companyId || b.actionId !== action.id || b.issueId !== heartbeat.issueId
    || b.workflowRunId !== step.workflowRunId || b.stepRunId !== step.id || b.missionId !== wake.missionId
    || a.intentKey !== action.intentKey
    || a.inputHash !== (target.data.kind === "current_output" ? target.data.source.inputHash : target.data.inputHash)) return reject();
  const [run] = await db.select({ missionId: workflowRuns.missionId }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, heartbeat.companyId), eq(workflowRuns.id, step.workflowRunId)));
  if (!run || run.missionId !== b.missionId) return reject();

  // Compare DB timestamps directly: JS Date truncates PostgreSQL microseconds and can accidentally
  // include a later same-millisecond reset. Never read mutable workflowRetry tracking as proof.
  const [scheduled] = await db.select({ event: workflowTransitionEvents }).from(workflowTransitionEvents)
    .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, wake.id))
    .where(and(eq(workflowTransitionEvents.companyId, heartbeat.companyId),
      eq(workflowTransitionEvents.workflowRunId, step.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, step.id),
      eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"),
      eq(workflowTransitionEvents.layer, "workflow_retry"),
      lte(workflowTransitionEvents.createdAt, agentWakeupRequests.requestedAt)))
    .orderBy(desc(workflowTransitionEvents.createdAt)).limit(1);
  if (!scheduled) return 0;
  const event = scheduled.event, payload = retryPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.stepRunId !== step.id
    || event.idempotencyKey !== `workflow-step-retry:${step.id}:${payload.data.retryNumber}`
    || event.fromStatus !== "failed" || event.toStatus !== "pending" || event.decision !== "retry"
    || event.reasonCode !== "workflow_step_retry_scheduled") return reject();
  return payload.data.retryNumber;
}
