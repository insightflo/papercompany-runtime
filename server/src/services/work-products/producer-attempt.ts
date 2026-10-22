import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { qualityProducerRetryCount } from "./quality-producer-attempt.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";
import { readQaCorrectionProducerAttempt } from "./qa-correction-producer-attempt.js";
import { readPauseChildProof } from "../heartbeat-pause-admission.js";

// Separate from technical ancestry: history readers can reenter through a verdict on the same heartbeat.
const activeAttempts = new AsyncLocalStorage<ReadonlySet<string>>();

type FullStep = typeof workflowStepRuns.$inferSelect;
export type ProducerAttemptIdentity = Pick<FullStep,
  "id" | "workflowRunId" | "stepId" | "issueId" | "executionGeneration" | "retryCount" | "iterationIndex">;
export type ProducerAttemptDetail = {
  retryCount: number;
  iterationIndex: number;
  rootHeartbeatRunId: string;
  rootWakeupRequestId: string;
};
type ProducerAttemptInput = {
  identity: ProducerAttemptIdentity;
  qualityStep: FullStep | null;
};

/** Read retry identity from the heartbeat's original server wake, never a later coalesced wake or step metadata. */
export async function producerAttempt(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  step: typeof workflowStepRuns.$inferSelect, ancestors = new Set<string>(), claiming = false): Promise<{ retryCount: number; iterationIndex: number }> {
  const { retryCount, iterationIndex } = await runProducerAttempt(db, heartbeat,
    { identity: step, qualityStep: step }, ancestors, claiming);
  return { retryCount, iterationIndex };
}

/** Prove a frozen historical identity without borrowing current step metadata or permitting an unstarted read. */
export function producerAttemptDetail(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  frozenIdentity: ProducerAttemptIdentity): Promise<ProducerAttemptDetail> {
  return runProducerAttempt(db, heartbeat, { identity: frozenIdentity, qualityStep: null }, new Set(), false);
}

async function runProducerAttempt(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  input: ProducerAttemptInput, ancestors: Set<string>, claiming: boolean): Promise<ProducerAttemptDetail> {
  const active = activeAttempts.getStore();
  if (active?.has(heartbeat.id)) throw conflict("workproduct_producer_attempt_unproven");
  return activeAttempts.run(new Set([...(active ?? []), heartbeat.id]),
    () => readProducerAttempt(db, heartbeat, input, ancestors, claiming));
}

async function readProducerAttempt(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  input: ProducerAttemptInput, ancestors: Set<string>, claiming: boolean): Promise<ProducerAttemptDetail> {
  const step = input.identity;
  const reject = () => { throw conflict("workproduct_producer_attempt_unproven"); };
  // ponytail: bounded ancestry (32); raise only if a supported retry policy legitimately exceeds it.
  if (ancestors.has(heartbeat.id) || ancestors.size >= 32) return reject();
  ancestors.add(heartbeat.id);
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
    const correction = await readQaCorrectionProducerAttempt(db, wake, heartbeat, step, proof, async (connection, ref) => {
      // Keep module initialization acyclic; the exported bridge is looked up on every correction read.
      const reader = await import("../workflow/control-flow/qa-correction-reader.js");
      return reader.readIssuedQaCorrectionFollowupForAttempt(connection, ref);
    });
    let retryCount: number;
    let root = { rootHeartbeatRunId: heartbeat.id, rootWakeupRequestId: wake.id };
    const pause = await readPauseChildProof(db, heartbeat, true);
    if (pause) {
      const frozen = pause.receipt.identity.workflow;
      if (!frozen || frozen.stepRunId !== step.id || frozen.runId !== step.workflowRunId
        || frozen.stepId !== step.stepId || frozen.executionGeneration !== step.executionGeneration
        || frozen.retryCount !== step.retryCount || frozen.iterationIndex !== step.iterationIndex) return reject();
      // Only this exact stopped/delivered receipt permits a never-started original.
      // Older pause scopes remain history; the recovery guard separately proves current permission.
      const parent = pause.parent;
      const parentAttempt = await runProducerAttempt(db, { ...parent, workflowStepRunId: frozen.stepRunId,
        workflowExecutionGeneration: frozen.executionGeneration }, {
        identity: { ...step, executionGeneration: frozen.executionGeneration,
          retryCount: frozen.retryCount, iterationIndex: frozen.iterationIndex },
        qualityStep: input.qualityStep ? { ...input.qualityStep, executionGeneration: frozen.executionGeneration,
          retryCount: frozen.retryCount, iterationIndex: frozen.iterationIndex } : null,
      }, ancestors, !parent.startedAt);
      if (parentAttempt.retryCount !== proof.retryCount || parentAttempt.iterationIndex !== proof.iterationIndex) return reject();
      return parentAttempt;
    }
    if (heartbeat.retryOfRunId) {
      if (wake.idempotencyKey !== null || !["process_lost_retry", "adapter_failed_retry", "adapter_fallback"].includes(wake.requestKind ?? "")
        || wake.reason !== wake.requestKind || wake.source !== "automation" || wake.requestedByActorType !== "system") return reject();
      const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.retryOfRunId));
      if (!parent || !parent.wakeupRequestId || parent.companyId !== heartbeat.companyId || parent.agentId !== heartbeat.agentId
        || parent.issueId !== heartbeat.issueId || parent.workflowStepRunId !== heartbeat.workflowStepRunId
        || parent.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
        || !parent.startedAt || parent.startedAt > (heartbeat.startedAt ?? heartbeat.createdAt)) return reject();
      const parentAttempt = await runProducerAttempt(db, parent, input, ancestors, false);
      retryCount = parentAttempt.retryCount;
      root = { rootHeartbeatRunId: parentAttempt.rootHeartbeatRunId, rootWakeupRequestId: parentAttempt.rootWakeupRequestId };
    } else if (correction) {
      retryCount = correction.retryCount;
      root = { rootHeartbeatRunId: correction.rootHeartbeatRunId, rootWakeupRequestId: correction.rootWakeupRequestId };
    // This exact key format is emitted by retry-launch-dispatch, not agent-authored prose or JSON.
    } else if (wake.idempotencyKey?.startsWith("workflow-step-retry:")) {
      retryCount = Number(wake.idempotencyKey.split(":")[2]);
      if (!Number.isSafeInteger(retryCount) || retryCount < 1
        || wake.idempotencyKey !== `workflow-step-retry:${step.id}:${retryCount}`) return reject();
    } else if (wake.idempotencyKey?.startsWith("quality-action-wake:")) {
      if (!input.qualityStep) return reject();
      retryCount = await qualityProducerRetryCount(db, wake, heartbeat, input.qualityStep);
    } else {
      retryCount = 0;
    }
    if (retryCount !== proof.retryCount) return reject();
    // Checkout projects a later display start. Only the immutable original admission proves this attempt.
    return { retryCount: proof.retryCount, iterationIndex: proof.iterationIndex, ...root };
  }
  return reject();
}
