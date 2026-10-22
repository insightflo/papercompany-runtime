import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, qualityActions as qualityActionRows, workflowStepRuns, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl, type PauseControl } from "./heartbeat-pause-contract.js";
import { lockCurrentScope, lockPauseFacts } from "./heartbeat-pause-intents.js";
import { isHeartbeatFinalizationV1Enabled } from "./heartbeat-finalization/flag.js";
import { observeQuiescenceProof, observeQuiescenceResources } from "./heartbeat-finalization/quiescence-probe.js";
import { parseQualityWakeKey } from "./quality/native-wake.js";
import { lockQualityAttemptBudget, readQualityStepActionId } from "./quality/retry-budget.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Outcome = "succeeded" | "failed" | "cancelled" | "timed_out";
const terminal = (run: Run) => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status);
const changed = (): never => { throw conflict("heartbeat_pause_scope_unproven_or_changed"); };
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
async function records(db: Db, agentId: string) {
  return (await db.select().from(agentWakeupRequests).where(marker(agentId))
    .orderBy(agentWakeupRequests.id)).map(readPauseControl);
}
function attempt(run: Run) {
  return [run.id, run.companyId, run.agentId, run.issueId, run.wakeupRequestId,
    run.workflowStepRunId, run.workflowExecutionGeneration, run.executionScopeKind, run.executionEpoch,
    run.executionToken, run.executorOwnerId, run.executorOwnerLeaseEpoch, run.executorOwnerLeaseToken,
    run.retryOfRunId, run.processLossRetryCount];
}

/** Observe the actual adapter promise, not the guard/transaction enclosing its start.
 * A start-transaction failure can return while that adapter is still running.
 */
export function createPauseExecutionObservation() {
  let invocation: unknown = null, pending = false, returned = false;
  return {
    async execute<T>(run: Run, invoke: () => Promise<T>): Promise<T> {
      invocation = attempt(run); pending = true; returned = false;
      try { return await invoke(); }
      finally { pending = false; returned = true; }
    },
    state(run: Run): "pending" | "returned" | "unknown" {
      if (pending) return "pending";
      return returned && isDeepStrictEqual(invocation, attempt(run)) ? "returned" : "unknown";
    },
  };
}
type Observation = ReturnType<typeof createPauseExecutionObservation>;

function executorStopped(run: Run, observation?: Observation): boolean {
  const state = observation?.state(run);
  if (state === "pending") return false;
  const tracked = runningProcesses.get(run.id);
  if (tracked && tracked.child.exitCode === null && tracked.child.signalCode === null) return false;
  if (run.processPid !== null) {
    if (!Number.isSafeInteger(run.processPid) || run.processPid <= 0) return false;
    try { process.kill(run.processPid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  // No PID, a deleted handle, cancelled, and child.killed are never positive observations.
  return state === "returned";
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

/** C05: save only an exact original's positive stop observation. This never delivers work.
 * Discovery precedes the established quality -> mission/run -> agent/attempt -> control locks.
 */
export async function recordPauseQuiescence(db: Db, observed: Run, observation?: Observation): Promise<number> {
  return db.transaction(async tx => {
    const t = tx as unknown as Db, preview = await records(t, observed.agentId);
    if (!preview.length) return 0;
    const heads = preview.filter(p => p.kind === "head");
    if (heads.length !== 1 || heads[0].companyId !== observed.companyId) return changed();
    const expected = heads[0];
    if (!expected.scopeId) return 0;
    const actions = await qualityActions(t, observed.companyId, observed.agentId, preview);
    for (const { id: actionId } of actions) {
      await lockQualityAttemptBudget(tx, { companyId: observed.companyId, actionId, now: new Date() });
    }
    await lockPauseFacts(t, { companyId: observed.companyId, agentId: observed.agentId, cause: "manual_pause",
      heartbeatRunIds: [], expectedScopeId: expected.scopeId });
    const current = await lockCurrentScope(t, observed.agentId, expected.scopeId);
    if (current.head.id !== expected.id || current.agent.companyId !== observed.companyId
      || !isDeepStrictEqual(actions, await qualityActions(t, observed.companyId, observed.agentId,
        await records(t, observed.agentId)))) return changed();
    const receipt = current.receipts.find(p => p.identity.heartbeatRunId === observed.id);
    if (!receipt || current.scope?.cause !== "manual_pause" || receipt.cause !== "manual_pause"
      || receipt.ownerScopeId !== expected.scopeId || receipt.invalidated || receipt.delivery || receipt.stopped) return 0;
    const [run] = await t.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, observed.id));
    if (!run || !isDeepStrictEqual(attempt(run), attempt(observed))) return changed();
    if (!terminal(run) || !executorStopped(run, observation)) return 0;
    const enabled = await isHeartbeatFinalizationV1Enabled(t);
    if (enabled && (run.finalizationVersion !== 1 || !run.settledAt || !await observeQuiescenceProof(t, run))) return 0;
    if (!enabled && !Object.values(await observeQuiescenceResources(t, run)).every(Boolean)) return 0;
    const payload = pauseControlSchema.parse({ ...receipt, stopped: {
      observedAt: new Date().toISOString(),
      method: enabled ? "finalization_quiescence" : "legacy_execution_cleanup",
      heartbeatRunId: run.id, executionEpoch: run.executionEpoch, executionToken: run.executionToken,
    } });
    const [saved] = await t.update(agentWakeupRequests).set({ payload, updatedAt: new Date() })
      .where(and(eq(agentWakeupRequests.id, receipt.id), eq(agentWakeupRequests.companyId, run.companyId),
        marker(run.agentId))).returning();
    if (!saved || !isDeepStrictEqual(readPauseControl(saved), payload)) return changed();
    return 1;
  });
}

type Cleanup = {
  db: Db;
  releaseRuntimeServicesForRun: (id: string) => Promise<void>;
  activeRunExecutions: Pick<Set<string>, "delete">;
  getRun: (id: string) => Promise<Run | null>;
  settleHeartbeatAfterExecution: (db: Db, run: Run, now: Date) => Promise<void>;
  requeueCoalescedWakeupsForFinishedRun: (db: Db, input: { companyId: string; runId: string }) => Promise<number>;
  finalizeAgentStatus: (agentId: string, outcome: Outcome) => Promise<void>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
};

/** Existing executeRun finally ordering, with stop evidence after release and mandatory settlement.
 * Failure leaves resume intent intact for the later existing requery integration.
 */
export async function finishPauseExecution(deps: Cleanup, original: Run, observation: Observation): Promise<void> {
  const { db } = deps;
  const released = await deps.releaseRuntimeServicesForRun(original.id).then(() => true, () => false);
  deps.activeRunExecutions.delete(original.id);
  const run = await deps.getRun(original.id).catch(() => null);
  if (run && terminal(run)) {
    await deps.settleHeartbeatAfterExecution(db, run, new Date()).catch(err => {
      logger.warn({ err, runId: original.id }, "failed to settle heartbeat after execution cleanup");
    });
    if (released) await recordPauseQuiescence(db, original, observation).catch(err => {
      logger.warn({ err, runId: original.id }, "failed to record pause execution quiescence");
    });
    // Preserve CMP-199 requeue before the same call promotes the next queued run.
    try {
      const requeuedCount = await deps.requeueCoalescedWakeupsForFinishedRun(db, { companyId: run.companyId, runId: run.id });
      if (requeuedCount > 0) logger.info({ runId: run.id, requeuedCount }, "requeued coalesced operator-decision wakeups for finished run");
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to requeue coalesced wakeups for finished run");
    }
    await deps.finalizeAgentStatus(original.agentId, run.status as Outcome).catch(() => undefined);
  }
  await deps.startNextQueuedRunForAgent(original.agentId);
}
