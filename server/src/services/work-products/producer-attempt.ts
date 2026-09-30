import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { qualityProducerRetryCount } from "./quality-producer-attempt.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";

/** Read retry identity from the heartbeat's original server wake, never a later coalesced wake or step metadata. */
export async function producerAttempt(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  step: typeof workflowStepRuns.$inferSelect, ancestors = new Set<string>(), claiming = false): Promise<{ retryCount: number; iterationIndex: number }> {
  const reject = () => { throw conflict("workproduct_producer_attempt_unproven"); };
  // ponytail: bounded ancestry (32); raise only if a supported retry policy legitimately exceeds it.
  if (ancestors.has(heartbeat.id) || ancestors.size >= 32) return reject();
  ancestors.add(heartbeat.id);
  let retryCount = 0;
  if (!heartbeat.wakeupRequestId || (!claiming && !heartbeat.startedAt)) return reject();
  if (heartbeat.wakeupRequestId) {
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
    if (!wake || wake.companyId !== heartbeat.companyId || wake.agentId !== heartbeat.agentId
      || wake.issueId !== heartbeat.issueId || wake.workflowRunId !== step.workflowRunId
      || wake.workflowStepRunId !== step.id || wake.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
      || wake.runId !== heartbeat.id || wake.status === "coalesced") return reject();
    const proof = readWorkflowAttemptProof(wake);
    if (proof.parentHeartbeatRunId !== heartbeat.retryOfRunId || proof.retryCount !== step.retryCount
      || proof.iterationIndex !== step.iterationIndex || proof.executionGeneration !== step.executionGeneration
      || (heartbeat.startedAt && heartbeat.startedAt < wake.requestedAt)) return reject();
    if (heartbeat.retryOfRunId) {
      if (wake.idempotencyKey !== null || !["process_lost_retry", "adapter_failed_retry", "adapter_fallback"].includes(wake.requestKind ?? "")
        || wake.reason !== wake.requestKind || wake.source !== "automation" || wake.requestedByActorType !== "system") return reject();
      const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.retryOfRunId));
      if (!parent || !parent.wakeupRequestId || parent.companyId !== heartbeat.companyId || parent.agentId !== heartbeat.agentId
        || parent.issueId !== heartbeat.issueId || parent.workflowStepRunId !== heartbeat.workflowStepRunId
        || parent.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
        || !parent.startedAt || parent.startedAt > (heartbeat.startedAt ?? heartbeat.createdAt)) return reject();
      retryCount = (await producerAttempt(db, parent, step, ancestors)).retryCount;
    // This exact key format is emitted by retry-launch-dispatch, not agent-authored prose or JSON.
    } else if (wake.idempotencyKey?.startsWith("workflow-step-retry:")) {
      retryCount = Number(wake.idempotencyKey.split(":")[2]);
      if (!Number.isSafeInteger(retryCount) || retryCount < 1
        || wake.idempotencyKey !== `workflow-step-retry:${step.id}:${retryCount}`) return reject();
    } else if (wake.idempotencyKey?.startsWith("quality-action-wake:")) {
      retryCount = await qualityProducerRetryCount(db, wake, heartbeat, step);
    }
    if (retryCount !== proof.retryCount) return reject();
    // Checkout projects a later display start. Only the immutable original admission proves this attempt.
    return { retryCount: proof.retryCount, iterationIndex: proof.iterationIndex };
  }
  return reject();
}
