import { and, desc, eq } from "drizzle-orm";
import { heartbeatRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { producerAttempt } from "../work-products/producer-attempt.js";

/** Generation alone does not distinguish generic retry or QA rework. Original admission does. */
export async function revisionCurrentHeartbeats(db: Pick<Db, "select">, companyId: string,
  step: typeof workflowStepRuns.$inferSelect) {
  if (!step.issueId) return [];
  const rows = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, step.issueId),
    eq(heartbeatRuns.workflowStepRunId, step.id), eq(heartbeatRuns.workflowExecutionGeneration, step.executionGeneration),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  const current: typeof rows = [];
  for (const heartbeat of rows) {
    try {
      await producerAttempt(db, heartbeat, step);
      current.push(heartbeat);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
      // Unproven/stale historical wakes are not evidence for the current attempt.
    }
  }
  return current;
}
