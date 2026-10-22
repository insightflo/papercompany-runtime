import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, qualityActions as qualityActionRows, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { agentService } from "./agents.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl, type PauseControl } from "./heartbeat-pause-contract.js";
import { lockCurrentScope, lockPauseFacts } from "./heartbeat-pause-intents.js";
import { parseQualityWakeKey } from "./quality/native-wake.js";
import { lockQualityAttemptBudget, readQualityStepActionId } from "./quality/retry-budget.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";

const changed = (): never => { throw conflict("heartbeat_pause_scope_unproven_or_changed"); };
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
async function records(db: Db, agentId: string) {
  return (await db.select().from(agentWakeupRequests).where(marker(agentId))
    .orderBy(agentWakeupRequests.id)).map(readPauseControl);
}

/** Discover the existing quality prefix without acquiring later mission/attempt locks.
 * Technical parents retain their original quality owner; current counters grant no approval.
 */
async function qualityActions(db: Db, companyId: string, agentId: string, controls: PauseControl[]) {
  const ids = controls.flatMap(p => p.kind === "receipt"
    ? [p.identity.heartbeatRunId, ...(p.delivery?.heartbeatRunId ? [p.delivery.heartbeatRunId] : [])] : []);
  const found = new Map<string, typeof heartbeatRuns.$inferSelect>();
  for (const original of ids) {
    let id: string | null = original;
    const chain = new Set<string>();
    while (id) {
      if (chain.has(id) || chain.size >= 32) return changed();
      chain.add(id);
      if (found.has(id)) break;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      if (!run || run.companyId !== companyId || run.agentId !== agentId) return changed();
      found.set(id, run); id = run.workflowStepRunId ? run.retryOfRunId : null;
    }
  }
  const runs = [...found.values()], actions = new Set<string>();
  const wakeIds = [...new Set(runs.flatMap(h => h.wakeupRequestId ? [h.wakeupRequestId] : []))];
  const wakes = wakeIds.length ? await db.select().from(agentWakeupRequests)
    .where(inArray(agentWakeupRequests.id, wakeIds)) : [];
  const stepIds = [...new Set([...runs, ...wakes].flatMap(r => r.workflowStepRunId ? [r.workflowStepRunId] : []))];
  const steps = stepIds.length ? await db.select().from(workflowStepRuns)
    .where(inArray(workflowStepRuns.id, stepIds)) : [];
  for (const step of steps) {
    const action = readQualityStepActionId(step.metadata);
    if (action) actions.add(action);
  }
  for (const wake of wakes) {
    if (wake.companyId !== companyId || wake.agentId !== agentId) return changed();
    if (!wake.workflowRunId || !wake.workflowStepRunId || wake.workflowExecutionGeneration === null) continue;
    const key = parseQualityWakeKey(wake.idempotencyKey);
    if (key) actions.add(key.actionId);
    const ref = readQaCorrectionWakeRef(wake);
    if (ref) {
      const { readIssuedQaCorrectionFollowup } = await import("./workflow/control-flow/qa-correction-followup.js");
      const { createQaCorrectionHistorySession } = await import("./workflow/control-flow/qa-correction-history-session.js");
      const selected = await readIssuedQaCorrectionFollowup(db, ref, createQaCorrectionHistorySession(db, ref));
      const authority = selected.issued.preparation.authority;
      if (authority.kind === "quality_current_output") actions.add(authority.actionId);
    }
  }
  const actionIds = [...actions];
  const prefix = actionIds.length ? await db.select({ id: qualityActionRows.id,
    policyVersionId: qualityActionRows.policyVersionId, groupId: qualityActionRows.groupId }).from(qualityActionRows)
    .where(and(eq(qualityActionRows.companyId, companyId), inArray(qualityActionRows.id, actionIds)))
    .orderBy(qualityActionRows.policyVersionId, qualityActionRows.groupId, qualityActionRows.id) : [];
  if (prefix.length !== actionIds.length) return changed();
  return prefix;
}

/** C05 adopted resume contract: one scope observation, one atomic approval/status save.
 * This boundary records intent only. Existing cleanup/delivery must prove actual termination.
 */
export async function commitAgentResume(db: Db, agentId: string) {
  return db.transaction(async tx => {
    const t = tx as unknown as Db;
    const [observed] = await t.select().from(agents).where(eq(agents.id, agentId));
    if (!observed) return null;
    const preview = await records(t, agentId);
    const heads = preview.filter(p => p.kind === "head");
    if (heads.length > 1 || (preview.length && heads.length !== 1)) return changed();
    const expected = heads[0];
    const resume = async () => {
      const agent = await agentService(t).resume(agentId);
      if (!agent || agent.status !== "idle") return changed();
      return agent;
    };
    if (!expected) {
      // Legacy pause: serialize with first head creation, without synthesizing a head or receipts.
      await t.select().from(companies).where(eq(companies.id, observed.companyId)).for("share");
      const [agent] = await t.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
      if (!agent || agent.companyId !== observed.companyId || (await records(t, agentId)).length) return changed();
      return resume();
    }
    const expectedScopeId = expected.scopeId;
    const actions = await qualityActions(t, observed.companyId, agentId, preview);
    for (const { id: actionId } of actions) {
      await lockQualityAttemptBudget(tx, { companyId: observed.companyId, actionId, now: new Date() });
    }
    // Reuse mission/run -> company/agent -> original/issue/step -> head/receipt ordering.
    await lockPauseFacts(t, { companyId: observed.companyId, agentId, cause: "manual_pause",
      heartbeatRunIds: [], ...(expectedScopeId ? { expectedScopeId } : {}) });
    const current = await lockCurrentScope(t, agentId, expectedScopeId ?? undefined);
    if (current.agent.companyId !== observed.companyId || current.head.id !== expected.id
      || current.head.scopeId !== expectedScopeId) return changed();
    // Discovery is not authority. A newly discovered earlier prefix requires rollback, never late locks.
    if (!isDeepStrictEqual(actions, await qualityActions(t, observed.companyId, agentId, await records(t, agentId)))) return changed();
    if (current.scope?.cause === "manual_pause") {
      for (const p of current.receipts) {
        if (p.invalidated || p.delivery || p.cause !== "manual_pause" || p.resumeScopeId === expectedScopeId) continue;
        const payload = pauseControlSchema.parse({ ...p, resumeScopeId: expectedScopeId });
        const [saved] = await t.update(agentWakeupRequests).set({ payload, updatedAt: new Date() })
          .where(and(eq(agentWakeupRequests.id, p.id), eq(agentWakeupRequests.companyId, observed.companyId),
            marker(agentId))).returning();
        if (!saved || !isDeepStrictEqual(readPauseControl(saved), payload)) return changed();
      }
    }
    return resume();
  });
}
