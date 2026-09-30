import { and, eq } from "drizzle-orm";
import { missions, workflowRecoveryAuthorities, workflowRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { validReplacementStart } from "./replacement-start-evidence.js";
import { withReplacementAgentQueue } from "./replacement-agent-delivery.js";

// Narrow replacement-only first delivery. The run lock spans native materialization/queue writes
// and the delivery receipt. A crash rolls all of those back; the committed initial claim survives.
export async function withReplacementFirstDelivery<T>(db: Db, runId: string, deliver: (tx: Db) => Promise<T>): Promise<T> {
  const [authority] = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.replacementRunId, runId));
  if (!authority) return deliver(db);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [observed] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!observed?.missionId) throw conflict("replacement_start_ineligible");
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, observed.missionId), eq(missions.companyId, authority.companyId))).for("update");
    await tx.select().from(workflowRuns).where(eq(workflowRuns.id, authority.workflowRunId)).for("update");
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    const receipt = run.metadata?.replacementStart as Record<string, unknown> | undefined;
    if (receipt?.deliveredAt) return deliver(t);
    if (mission?.status !== "active" || run.status !== "running" || receipt?.schemaVersion !== 1
      || receipt.authorityId !== authority.id || receipt.authorityVersion !== 0 || !await validReplacementStart(t, run)) {
      throw conflict("replacement_start_ineligible");
    }
    const { result, agentWakeupRequestIds } = await withReplacementAgentQueue(t, runId, () => deliver(t));
    const [current] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    await tx.update(workflowRuns).set({ metadata: { ...current.metadata,
      replacementStart: { ...receipt, deliveredAt: new Date().toISOString(),
        ...(agentWakeupRequestIds.length ? { agentWakeupRequestIds } : {}) } } }).where(eq(workflowRuns.id, runId));
    return result;
  });
}
