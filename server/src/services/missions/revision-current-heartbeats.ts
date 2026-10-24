import { and, desc, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";

/** Generation alone does not distinguish generic retry or QA rework. Original admission does.
 * A terminalized run fences every step generation forward without scheduling a new attempt,
 * so the newest generation that actually produced heartbeats is the attempt a revision reads.
 * Writes stay fenced by the terminal boundary; this reader only classifies recorded history. */
export async function revisionCurrentHeartbeats(db: Pick<Db, "select">, companyId: string,
  step: typeof workflowStepRuns.$inferSelect) {
  if (!step.issueId) return [];
  const rows = (await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, step.issueId),
    eq(heartbeatRuns.workflowStepRunId, step.id),
  )).orderBy(desc(heartbeatRuns.workflowExecutionGeneration), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)))
    .filter(h => h.workflowExecutionGeneration != null);
  if (!rows.length) return [];
  const attemptGeneration = rows[0].workflowExecutionGeneration!;
  const current: typeof rows = [];
  for (const heartbeat of rows) {
    if (heartbeat.workflowExecutionGeneration !== attemptGeneration) continue;
    try {
      await producerAttempt(db, heartbeat, step);
      current.push(heartbeat);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
      // Unproven/stale wakes are not evidence for the live attempt; only a fenced dead run
      // may substitute the attempt's own original admission proof (never row presence).
      if (attemptGeneration === step.executionGeneration) continue;
      if (await provenDeadRunAttempt(db, heartbeat, step)) current.push(heartbeat);
    }
  }
  return current;
}

/** A terminal fence advances generation without a new attempt. The wake's stored admission
 * proof is server-written under a step lock and binds identity to its own generation, so
 * internal consistency with its heartbeat proves that older attempt actually ran. */
async function provenDeadRunAttempt(db: Pick<Db, "select">, heartbeat: typeof heartbeatRuns.$inferSelect,
  step: typeof workflowStepRuns.$inferSelect) {
  if (!heartbeat.wakeupRequestId || !heartbeat.startedAt) return false;
  const [wake] = await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
  if (!wake || wake.companyId !== heartbeat.companyId || wake.agentId !== heartbeat.agentId
    || wake.issueId !== heartbeat.issueId || wake.workflowRunId !== step.workflowRunId
    || wake.workflowStepRunId !== step.id || wake.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
    || wake.runId !== heartbeat.id || wake.status === "coalesced") return false;
  try {
    readWorkflowAttemptProof(wake);
    return heartbeat.startedAt >= wake.requestedAt;
  } catch {
    return false;
  }
}
