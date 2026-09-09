import { eq, sql } from "drizzle-orm";
import { activityLog, toolExecutionHeartbeats, type Db } from "@paperclipai/db";
import { createToolProgressStore } from "../../services/tools/progress-store.js";
import { policy, progressTool } from "./tool-progress.js";

export async function progressRecord(db: Db, reader: Db, adapterType = "builtin", tokenHash?: string) {
  const scope = await progressTool(db, adapterType);
  const store = createToolProgressStore(db);
  const row = await store.start(scope, policy, tokenHash);
  const read = async () => (await reader.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.id, row.id)))[0];
  const audit = () => reader.select().from(activityLog).where(eq(activityLog.entityId, row.id)).orderBy(activityLog.createdAt, activityLog.id);
  const eligible = () => db.update(toolExecutionHeartbeats)
    .set({ lastProgressAt: sql`clock_timestamp() - interval '1100 milliseconds'` }).where(eq(toolExecutionHeartbeats.id, row.id));
  return { scope, store, row, read, audit, eligible };
}
