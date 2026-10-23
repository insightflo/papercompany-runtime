import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { assertHeartbeatRecoveryAdmission } from "./heartbeat-recovery-guard.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Wake = typeof agentWakeupRequests.$inferSelect;

function pending(error: unknown) {
  return error instanceof Error && error.message === "operator_decision_delivery_pending_acceptance";
}

/** Preserve authority/continuation -> wake lock order, then revalidate the locked stored row. */
export async function lockStoredRecoveryAdmission(tx: Tx, observed: Wake, contextKey: string) {
  const validate = (wake: Wake) => assertHeartbeatRecoveryAdmission(tx as unknown as Db, {
    ...wake, wakeupRequestId: wake.id, contextSnapshot: parseObject(wake.payload)[contextKey],
    operatorDecisionStoredAdmission: true,
  });
  try { await validate(observed); } catch (error) { if (pending(error)) return null; throw error; }
  const [locked] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, observed.id), eq(agentWakeupRequests.companyId, observed.companyId),
  )).for("update");
  if (!locked) return null;
  try { await validate(locked); } catch (error) { if (pending(error)) return null; throw error; }
  return locked;
}
