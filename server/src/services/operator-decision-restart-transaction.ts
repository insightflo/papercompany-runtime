import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { missions, workflowRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import {
  createReplacementRootNotifications, currentReplacementRootNotifications,
  QaCorrectionRootOwnerRequired, withReplacementRootNotificationDb,
} from "./issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "./workflow/replacement-agent-delivery.js";
import type { ResumeMutationTransaction } from "./workflow/resume/serialization.js";

/** Queue inside the decision transaction, but allow execution only after its owning commit. */
export async function withOperatorRestartTransaction<T>(db: Db, input: {
  companyId: string; missionId: string; sourceRunId: string;
}, resolve: (tx: ResumeMutationTransaction) => Promise<T>): Promise<T> {
  const ownsCommit = !is(db, PgTransaction);
  const outer = ownsCommit ? null : currentReplacementRootNotifications(db);
  const notifications = createReplacementRootNotifications();
  const result = await db.transaction(async tx => withReplacementRootNotificationDb(tx as unknown as Db, notifications, async () => {
    const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
      eq(missions.id, input.missionId), eq(missions.companyId, input.companyId),
    )).for("update");
    if (!mission) throw conflict("workflow_restart_scope_missing");
    await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.id, input.sourceRunId), eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
    )).for("update");
    const value = await resolve(tx);
    if (!ownsCommit && !outer && (notifications.agentIds.size || notifications.correctionWakeupRequestIds.size)) {
      throw new QaCorrectionRootOwnerRequired();
    }
    return value;
  }));
  if (ownsCommit) {
    await drainReplacementRootNotifications(db, notifications);
  } else if (outer) {
    for (const agentId of notifications.agentIds) outer.agentIds.add(agentId);
    for (const wakeId of notifications.correctionWakeupRequestIds) outer.correctionWakeupRequestIds.add(wakeId);
  }
  return result;
}
