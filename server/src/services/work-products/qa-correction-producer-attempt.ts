import { isDeepStrictEqual } from "node:util";
import { and, eq, lte } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { qaCorrectionFollowupRefSchema, type QaCorrectionFollowupRef } from "../workflow/control-flow/qa-correction-contract.js";
import type { readIssuedQaCorrectionFollowup } from "../workflow/control-flow/qa-correction-followup.js";
import type { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";

export const QA_CORRECTION_WAKE_PREFIX = "qa-correction-wake:";
type History = Awaited<ReturnType<typeof readIssuedQaCorrectionFollowup>>;
type ReadHistory = (db: Pick<Db, "select">, ref: QaCorrectionFollowupRef) => Promise<History>;
const reject = (): never => { throw conflict("workproduct_producer_attempt_unproven"); };

/** Transport identity only: this key proves neither issuance, uniqueness nor current execution permission. */
export function qaCorrectionWakeKey(ref: QaCorrectionFollowupRef): string {
  return QA_CORRECTION_WAKE_PREFIX + qaCorrectionFollowupRefSchema.parse(ref).requestId;
}

/** Only the ref is strict: the server also stores its attempt proof in the surrounding payload. */
export function readQaCorrectionWakeRef(wake: typeof agentWakeupRequests.$inferSelect): QaCorrectionFollowupRef | null {
  const present = Object.hasOwn(wake.payload ?? {}, "qaCorrectionFollowup");
  const key = wake.idempotencyKey;
  const reserved = key?.startsWith(QA_CORRECTION_WAKE_PREFIX.slice(0, -1))
    || key?.startsWith("qa-correction-followup");
  if (!present && !reserved) return null;
  const parsed = qaCorrectionFollowupRefSchema.safeParse(wake.payload?.qaCorrectionFollowup);
  if (!parsed.success || key !== qaCorrectionWakeKey(parsed.data)) return reject();
  return parsed.data;
}

/** SELECT-only historical proof. The injected reader also proves revisions and original producer ancestry. */
export async function readQaCorrectionProducerAttempt(db: Pick<Db, "select">,
  wake: typeof agentWakeupRequests.$inferSelect, heartbeat: typeof heartbeatRuns.$inferSelect,
  step: typeof workflowStepRuns.$inferSelect, proof: ReturnType<typeof readWorkflowAttemptProof>,
  readHistory: ReadHistory) {
  const ref = readQaCorrectionWakeRef(wake);
  if (!ref) return null;
  if (heartbeat.retryOfRunId !== null || proof.parentHeartbeatRunId !== null) return reject();
  const selected = await readHistory(db, ref);
  const { issued, followup, revisions } = selected, p = issued.preparation, target = followup.target;
  if (!isDeepStrictEqual(selected.ref, ref) || p.companyId !== ref.companyId
    || p.workflowRunId !== ref.workflowRunId || followup.requestId !== ref.requestId
    || followup.appliedEventId !== ref.appliedEventId || followup.correctionId !== p.correctionId
    || !isDeepStrictEqual(revisions.map(r => r.revision.revisionId), followup.revisionIds)) return reject();
  if (ref.companyId !== heartbeat.companyId || wake.companyId !== heartbeat.companyId
    || wake.agentId !== heartbeat.agentId || wake.issueId !== heartbeat.issueId
    || wake.missionId !== p.missionId || wake.workflowRunId !== ref.workflowRunId
    || wake.workflowStepRunId !== target.stepRunId || wake.runId !== heartbeat.id
    || heartbeat.wakeupRequestId !== wake.id || heartbeat.workflowStepRunId !== target.stepRunId
    || heartbeat.workflowExecutionGeneration !== target.executionGeneration
    || wake.workflowExecutionGeneration !== target.executionGeneration || wake.status === "coalesced"
    || step.workflowRunId !== ref.workflowRunId || step.id !== target.stepRunId || step.stepId !== target.stepId
    || step.issueId !== target.issueId || heartbeat.issueId !== target.issueId
    || step.executionGeneration !== target.executionGeneration || step.retryCount !== target.retryCount
    || step.iterationIndex !== target.iterationIndex) return reject();
  if (proof.companyId !== ref.companyId || proof.agentId !== heartbeat.agentId || proof.issueId !== target.issueId
    || proof.missionId !== p.missionId || proof.workflowRunId !== ref.workflowRunId
    || proof.stepRunId !== target.stepRunId || proof.executionGeneration !== target.executionGeneration
    || proof.retryCount !== target.retryCount || proof.iterationIndex !== target.iterationIndex
    || proof.wakeupRequestId !== wake.id) return reject();
  // Compare in PostgreSQL: JavaScript Date loses sub-millisecond timestamp ordering.
  const [event] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, wake.id))
    .where(and(eq(workflowTransitionEvents.id, selected.followupEventId),
      eq(workflowTransitionEvents.companyId, ref.companyId), eq(workflowTransitionEvents.workflowRunId, ref.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_correction_followup_requested"),
      lte(workflowTransitionEvents.createdAt, agentWakeupRequests.requestedAt))).limit(1);
  if (!event) return reject();
  // A legacy origin remains null inside selected.revisions; never manufacture a producer or compare QA/author agents.
  return { retryCount: target.retryCount, iterationIndex: target.iterationIndex, ref,
    followupEventId: selected.followupEventId, rootWakeupRequestId: wake.id, rootHeartbeatRunId: heartbeat.id };
}
