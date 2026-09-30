import { z } from "zod";
import type { agentWakeupRequests } from "@paperclipai/db";
import { conflict } from "../../errors.js";

export const WORKFLOW_ATTEMPT_PROOF_KEY = "__paperclipWorkflowProducerAttempt";
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const workflowAttemptProofSchema = z.object({
  schemaVersion: z.literal(1), companyId: z.string().uuid(), agentId: z.string().uuid(),
  issueId: z.string().uuid().nullable(), missionId: z.string().uuid().nullable(),
  workflowRunId: z.string().uuid(), stepRunId: z.string().uuid(), executionGeneration: counter,
  retryCount: counter, iterationIndex: counter, wakeupRequestId: z.string().uuid(),
  parentHeartbeatRunId: z.string().uuid().nullable(),
}).strict();

/** Reserved server field: no caller payload or deferred/context hint is authority. */
export function withoutWorkflowAttemptProof(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  const clean = { ...payload };
  delete clean[WORKFLOW_ATTEMPT_PROOF_KEY];
  const context = clean._paperclipWakeContext;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const nested = { ...context } as Record<string, unknown>;
    delete nested[WORKFLOW_ATTEMPT_PROOF_KEY];
    clean._paperclipWakeContext = nested;
  }
  return clean;
}

/** A later merge preserves the first admission, including malformed/missing legacy evidence. */
export function preserveWorkflowAttemptProof(original: Record<string, unknown> | null, incoming: Record<string, unknown> | null) {
  const clean = withoutWorkflowAttemptProof(incoming);
  return original && Object.hasOwn(original, WORKFLOW_ATTEMPT_PROOF_KEY)
    ? { ...clean, [WORKFLOW_ATTEMPT_PROOF_KEY]: original[WORKFLOW_ATTEMPT_PROOF_KEY] } : clean;
}

export function readWorkflowAttemptProof(wake: typeof agentWakeupRequests.$inferSelect) {
  const parsed = workflowAttemptProofSchema.safeParse(wake.payload?.[WORKFLOW_ATTEMPT_PROOF_KEY]);
  const reject = () => { throw conflict("workproduct_producer_attempt_unproven"); };
  if (!parsed.success) return reject();
  const p = parsed.data;
  if (p.companyId !== wake.companyId || p.agentId !== wake.agentId || p.issueId !== wake.issueId
    || p.missionId !== wake.missionId || p.workflowRunId !== wake.workflowRunId || p.stepRunId !== wake.workflowStepRunId
    || p.executionGeneration !== wake.workflowExecutionGeneration || p.wakeupRequestId !== wake.id) return reject();
  return p;
}
