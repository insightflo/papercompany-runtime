import { eq } from "drizzle-orm";
import { agentWakeupRequests, type Db, type heartbeatRuns } from "@paperclipai/db";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";

export async function isCorrectionRun(execDb: Db, run: typeof heartbeatRuns.$inferSelect) {
    if (!run.wakeupRequestId) return false;
    const [wake] = await execDb.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    return !!wake && !!readQaCorrectionWakeRef(wake);
  }
