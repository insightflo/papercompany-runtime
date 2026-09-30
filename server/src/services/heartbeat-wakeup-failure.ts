import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, type Db, type heartbeatRuns } from "@paperclipai/db";

/** Called only with the row returned by a successful running -> failed transition.
 * A later cancellation (or wake reassignment) must still win at this write boundary. */
export async function failWakeupForFailedHeartbeat(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (!run.wakeupRequestId || run.status !== "failed") return;
  await db.update(agentWakeupRequests)
    .set({ status: "failed", finishedAt: new Date(), error: run.error, updatedAt: new Date() })
    .where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId),
      eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.runId, run.id),
      inArray(agentWakeupRequests.status, ["queued", "claimed"]),
    ));
}
