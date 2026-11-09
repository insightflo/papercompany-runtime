// A pause receipt whose mission is terminal can never accept the resume: the sweep retires it as
// invalidated once instead of retrying the same admission refusal every cycle. A merely paused
// mission still blocks work but may resume, so only terminal statuses retire the intent.
import { isDeepStrictEqual as same } from "node:util";
import { and, eq, is, or } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, missions, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl } from "./heartbeat-pause-contract.js";
import { deliverPauseResume, readPauseDeliveryOriginal } from "./heartbeat-pause-delivery.js";
import { recheckPauseQuiescence } from "./heartbeat-pause-quiescence.js";

const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);

/** SELECT only: cheap filter so the settle transaction runs only for receipts on a terminal mission. */
async function receiptMissionIsTerminal(db: Pick<Db, "select">, receiptId: string) {
  const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId));
  if (!row) return false;
  const control = readPauseControl(row);
  if (control.kind !== "receipt" || !control.identity.missionId) return false;
  const [mission] = await db.select({ status: missions.status }).from(missions).where(and(
    eq(missions.id, control.identity.missionId), eq(missions.companyId, control.identity.companyId)));
  return Boolean(mission && TERMINAL_MISSION_STATUSES.has(mission.status));
}

function isTerminalMissionRefusal(err: unknown) {
  const refusal = err as { code?: unknown; status?: unknown };
  return err instanceof Error && refusal.code === "mission_not_accepting_work"
    && TERMINAL_MISSION_STATUSES.has(String(refusal.status));
}

/** Re-prove the receipt is still an undelivered candidate and lock its own mission as durably
 * terminal before retiring it; any concurrent change keeps the intent for the next sweep. */
async function settleTerminalMissionReceipt(db: Db, receiptId: string): Promise<boolean> {
  if (is(db, PgTransaction)) return false;
  try {
    return await db.transaction(async tx => {
      const t = tx as unknown as Db;
      const original = await readPauseDeliveryOriginal(t, receiptId);
      const receipt = original.receipt;
      if (receipt.invalidated || receipt.delivery || receipt.resumeScopeId !== receipt.ownerScopeId) return false;
      const missionId = receipt.identity.missionId;
      if (!missionId) return false;
      const [mission] = await t.select({ status: missions.status }).from(missions).where(and(
        eq(missions.id, missionId), eq(missions.companyId, receipt.identity.companyId))).for("no key update");
      if (!mission || !TERMINAL_MISSION_STATUSES.has(mission.status)) return false;
      const [locked] = await t.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptId)).for("update");
      if (!locked || !same(readPauseControl(locked), receipt)) return false;
      const now = new Date();
      const payload = pauseControlSchema.parse({ ...receipt,
        invalidated: { cause: "mission_terminal", at: now.toISOString() } });
      const [saved] = await t.update(agentWakeupRequests).set({ payload, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, receiptId), marker(receipt.agentId))).returning();
      return Boolean(saved && same(readPauseControl(saved), payload));
    });
  } catch {
    return false;
  }
}

/** One sweep attempt per receipt: quiescence, then delivery; a terminal mission retires the intent. */
export async function attemptPauseResumeDelivery(db: Db, agentId: string, receiptId: string) {
  const retired = async () => {
    if (await settleTerminalMissionReceipt(db, receiptId)) {
      logger.info({ agentId, pauseReceiptId: receiptId }, "pause resume receipt retired: mission terminal");
      return true;
    }
    return false;
  };
  try {
    if (await receiptMissionIsTerminal(db, receiptId) && await retired()) return null;
    if (!await recheckPauseQuiescence(db, receiptId)) return null;
    return await deliverPauseResume(db, receiptId);
  } catch (err) {
    // The writer rolled back. Preserve intent and allow independent ordinary work to proceed.
    if (isTerminalMissionRefusal(err) && await retired()) return null;
    logger.warn({ err, agentId, pauseReceiptId: receiptId }, "pause resume delivery deferred");
    return null;
  }
}
