import { and, eq, inArray, is, or } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { PgTransaction } from "drizzle-orm/pg-core";
import { isQaCorrectionRootOwnerRequired } from "./issue-assignment-wakeup.js";
import { captureQaCorrectionExecutionIdentity, isClaimDiscoveryHold, QaCorrectionClaimRejected, withQaCorrectionClaimRoot,
  withQaCorrectionExecutionRoot, type ExecutionBoundary, type QaCorrectionExecutionBox }
  from "./workflow/control-flow/qa-correction-claim-root.js";
import { isC5PreInvocationRollback, QaRemediationAdmissionHold, readC5NotInvokedProof, type QaRemediationSharedAdmissionRuntime }
  from "./workflow/control-flow/qa-remediation-admission-root.js";
import { conflict, HttpError } from "../errors.js";
import { budgetService } from "./budgets.js";
import { assertRunNotReplaced } from "./workflow/run-replacement-guard.js";
import { budgetBlockers } from "./workflow/resume/preview-facts.js";
import { assertMissionRuntimeAcceptsWork } from "./missions/mission-runtime-manager.js";
import { claimQueuedHeartbeatRun } from "./heartbeat-finalization/shadow-writes.js";
import { preparePauseChildAdmission, assertCurrentPauseChild, type PauseChildAdmission } from "./heartbeat-pause-admission.js";
import { acceptOwnerHumanResponseAtClaim, assertOwnerHumanResponseDelivery,
  recordOwnerHumanAdapterStart, type OwnerResponseRun, type OwnerResponseScope,
} from "./missions/owner-human-response.js";

type Scope = OwnerResponseScope & {
  id?: string;
  companyId: string; agentId: string;
  issueId?: string | null; missionId?: string | null;
  workflowRunId?: string | null; workflowStepRunId?: string | null;
  contextSnapshot?: unknown; wakeupRequestId?: string | null; idempotencyKey?: string | null;
  source?: string | null; reason?: string | null; payload?: unknown;
  requestedByActorType?: string | null; requestedByActorId?: string | null;
  operatorDecisionInitialAdmission?: boolean; operatorDecisionStoredAdmission?: boolean; operatorDecisionOnly?: boolean;
};
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

/** OR all identity paths; owner issue membership alone is not execution linkage. Caller owns the transaction. */
export async function assertHeartbeatRecoveryAdmission(db: Db, input: Scope) {
  const context = record(input.contextSnapshot);
  let ownerDelivery = Boolean(await assertOwnerHumanResponseDelivery(db, input));
  if (!ownerDelivery && input.id && input.wakeupRequestId
    && !input.operatorDecisionInitialAdmission && !input.operatorDecisionStoredAdmission) {
    ownerDelivery = Boolean(await acceptOwnerHumanResponseAtClaim(db, input as OwnerResponseRun));
  }
  if (input.operatorDecisionOnly) return;
  const issueIds = [...new Set([input.issueId, text(context.issueId)].filter((id): id is string => !!id))];
  const stepIds = [...new Set([input.workflowStepRunId, text(context.workflowStepRunId)].filter((id): id is string => !!id))];
  const runIds = new Set([input.workflowRunId, text(context.workflowRunId)].filter((id): id is string => !!id));
  if (input.wakeupRequestId) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId)));
    if (wake?.workflowRunId) runIds.add(wake.workflowRunId);
    if (wake?.workflowStepRunId) stepIds.push(wake.workflowStepRunId);
    if (wake?.issueId) issueIds.push(wake.issueId);
  }
  if (issueIds.length || stepIds.length) {
    const steps = await db.select({ runId: workflowStepRuns.workflowRunId }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(eq(workflowRuns.companyId, input.companyId), or(inArray(workflowStepRuns.issueId, issueIds), inArray(workflowStepRuns.id, stepIds))));
    for (const step of steps) runIds.add(step.runId);
    const origins = await db.select({ runId: issues.originRunId }).from(issues).where(and(
      eq(issues.companyId, input.companyId), inArray(issues.id, issueIds), eq(issues.originKind, "workflow_execution")));
    for (const origin of origins) if (origin.runId) runIds.add(origin.runId);
  }
  if (!runIds.size && !input.missionId && !ownerDelivery) return;
  const runs = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId), inArray(workflowRuns.id, [...runIds])));
  if (runs.length !== runIds.size) throw conflict("heartbeat_workflow_scope_missing");
  runs.sort((a, b) => (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id));
  // A pause receipt can carry an explicit original mission without borrowing a workflow from context.
  if (input.missionId && !runs.some(r => r.missionId === input.missionId)) {
    await db.select().from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("no key update");
    await assertMissionRuntimeAcceptsWork(db, { companyId: input.companyId, missionId: input.missionId });
  }
  for (const run of runs) {
    // NO KEY UPDATE conflicts with replacement's UPDATE lock but permits FK key-share
    // reads by the existing session initializer on its separate connection.
    if (run.missionId) {
      await db.select().from(missions).where(and(eq(missions.id, run.missionId), eq(missions.companyId, input.companyId))).for("no key update");
      await assertMissionRuntimeAcceptsWork(db, { companyId: input.companyId, missionId: run.missionId });
    }
    const [locked] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, input.companyId))).for("no key update");
    if (!locked || locked.missionId !== run.missionId) throw conflict("workflow_run_scope_changed");
    await assertRunNotReplaced(db, run.id, input.companyId);
    if (locked.status === "cancelled") throw conflict("workflow_run_cancelled");
  }
  // The monthly counters are authoritative even before an asynchronous pause policy fires.
  // Share locks keep budget/cancel updates from crossing the actual adapter-start boundary.
  const [company] = await db.select().from(companies).where(eq(companies.id, input.companyId)).for("share");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  if (!company || !agent || budgetBlockers(company).length || budgetBlockers(agent).length) throw conflict("heartbeat_workflow_budget_hard_stop");
  if (["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("heartbeat_agent_not_invokable");
  const block = await budgetService(db).getInvocationBlock(input.companyId, input.agentId, {
    issueId: input.issueId ?? text(context.issueId), projectId: text(context.projectId),
  });
  if (block) throw conflict(block.reason);
}

/** Claim and replacement admission serialize on the same mission/source-run locks. */
async function claimWithinAdmission(t: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date,
  pause: PauseChildAdmission | null) {
  const [agent] = await t.select().from(agents).where(eq(agents.id, run.agentId));
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("Cancelled because the agent is not invokable");
  const context = record(run.contextSnapshot);
  const block = await budgetService(t).getInvocationBlock(run.companyId, run.agentId, { issueId: text(context.issueId), projectId: text(context.projectId) });
  if (block) throw conflict(block.reason);
  const missionId = text(context.missionId);
  if (missionId) await assertMissionRuntimeAcceptsWork(t, { companyId: run.companyId, missionId });
  await assertCurrentPauseChild(t, run, pause);
  return await claimQueuedHeartbeatRun(t, run, claimedAt);
}

async function guardedClaim(db: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date) {
  let pause: PauseChildAdmission | null = null;
  return withQaCorrectionClaimRoot(db, run, async t => {
    pause = await preparePauseChildAdmission(t, run, missionId => assertHeartbeatRecoveryAdmission(t, { ...run, missionId }));
  }, async t => claimWithinAdmission(t, run, claimedAt, pause));
}

// Preserve main's definitive refusal before C5 discovery; locked admission still rechecks before work.
async function preflightC5Refusal(db: Db, run: typeof heartbeatRuns.$inferSelect, adapterStart = false) {
  const passed = {}; // Even a successful preflight must roll back owner-response acceptance writes.
  try {
    await db.transaction(async tx => {
      await assertHeartbeatRecoveryAdmission(tx as unknown as Db, run);
      if (!adapterStart) throw passed;
      const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("share");
      if (!current || current.status !== "running" || executionIdentity(current) !== executionIdentity(run)) {
        throw conflict("heartbeat_execution_cancelled_or_scope_changed");
      }
      throw passed;
    });
  } catch (error) {
    if (error === passed) return;
    const missionRefusal = error instanceof Error && "code" in error && error.code === "mission_not_accepting_work";
    throw error instanceof HttpError || missionRefusal ? new QaCorrectionClaimRejected(error) : error;
  }
}

async function guardedC5Claim(db: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date,
  sharedAdmission: QaRemediationSharedAdmissionRuntime): Promise<ExecutionBoundary<typeof heartbeatRuns.$inferSelect | null>> {
  await preflightC5Refusal(db, run);
  let pause: PauseChildAdmission | null = null;
  return withQaCorrectionExecutionRoot(db, run, {
    phase: "claim",
    sharedAdmission,
    admit: async (t, currentRun) => {
      pause = await preparePauseChildAdmission(t, currentRun,
        missionId => assertHeartbeatRecoveryAdmission(t, { ...currentRun, missionId }));
    },
    work: async (t, currentRun) => claimWithinAdmission(t, currentRun, claimedAt, pause),
  });
}

/** Preserve the existing direct claim API; public queue callers also distinguish registered deferral. */
export async function claimHeartbeatWithRecoveryGuard(db: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date) {
  const outcome = await guardedClaim(db, run, claimedAt);
  return outcome.kind === "performed" ? outcome.value : null;
}

function executionIdentity(run: typeof heartbeatRuns.$inferSelect) {
  const context = record(run.contextSnapshot);
  return JSON.stringify([run.agentId, run.issueId, run.wakeupRequestId, run.workflowStepRunId,
    run.workflowExecutionGeneration, run.retryOfRunId, context.issueId, context.workflowRunId, context.workflowStepRunId]);
}

/** Start the adapter under the lock, but never hold a DB transaction for its lifetime.
 * The returned box prevents Promise assimilation until after the transaction commits.
 */
export async function executeHeartbeatWithRecoveryGuard<T>(db: Db, run: typeof heartbeatRuns.$inferSelect, execute: () => Promise<T>): Promise<T> {
  let pause: PauseChildAdmission | null = null;
  const started = await withQaCorrectionClaimRoot(db, run, async t => {
    pause = await preparePauseChildAdmission(t, run, missionId => assertHeartbeatRecoveryAdmission(t, { ...run, missionId }));
  }, async t => {
    await assertCurrentPauseChild(t, run, pause);
    // C08 currentness owns the mission/authority prefix before the heartbeat lock.
    // The locked heartbeat is then revalidated before the adapter can start.
    await recordOwnerHumanAdapterStart(t, run);
    const [current] = await t.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("share");
    if (!current || current.status !== "running" || executionIdentity(current) !== executionIdentity(run)) {
      throw Object.assign(conflict("heartbeat_execution_cancelled_or_scope_changed"), { code: "heartbeat_recovery_blocked" });
    }
    const result = execute();
    // Attach immediately so an adapter's synchronous rejection cannot be unhandled while committing.
    void result.catch(() => {});
    return { result };
  }).catch(error => {
    throw Object.assign(error, { code: "heartbeat_recovery_blocked" });
  });
  if (started.kind !== "performed") {
    throw Object.assign(conflict("heartbeat_execution_deferred"), { code: "heartbeat_recovery_blocked" });
  }
  return started.value.result;
}

/** Opt-in public adapter start: retain the existing heartbeat admission checks while
 * returning C5's authenticated pre-invocation hold separately from started work.
 */
export async function startHeartbeatWithC5ExecutionGuard<T>(db: Db,
  run: typeof heartbeatRuns.$inferSelect, execute: () => Promise<T>,
  sharedAdmission: QaRemediationSharedAdmissionRuntime): Promise<ExecutionBoundary<QaCorrectionExecutionBox<T>>> {
  let pause: PauseChildAdmission | null = null;
  try {
    await preflightC5Refusal(db, run, true);
    return await withQaCorrectionExecutionRoot(db, run, {
      phase: "adapter_start",
      sharedAdmission,
      admit: async (t, currentRun) => {
        pause = await preparePauseChildAdmission(t, currentRun,
          missionId => assertHeartbeatRecoveryAdmission(t, { ...currentRun, missionId }));
      },
      work: async (t, currentRun, _scope, _context, invokeOnce) => {
        await assertCurrentPauseChild(t, currentRun, pause);
        await recordOwnerHumanAdapterStart(t, currentRun);
        const [current] = await t.select().from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, currentRun.id), eq(heartbeatRuns.companyId, currentRun.companyId))).for("share");
        if (!current || current.status !== "running" || executionIdentity(current) !== executionIdentity(currentRun)) {
          throw Object.assign(conflict("heartbeat_execution_cancelled_or_scope_changed"), { code: "heartbeat_recovery_blocked" });
        }
        return invokeOnce(execute);
      },
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("heartbeat recovery admission failed", { cause: error });
    throw Object.assign(failure, { code: "heartbeat_recovery_blocked" });
  }
}

type Run = typeof heartbeatRuns.$inferSelect;
export type ClaimOutcome =
  | { kind: "claimed"; run: Run }
  | { kind: "not_claimed" }
  | { kind: "root_deferred" }
  | { kind: "correction_rejected" }
  | { kind: "c5_held" }
  | { kind: "c5_unknown" };
type ClaimEffects = {
  db: Db;
  sharedAdmission?: QaRemediationSharedAdmissionRuntime;
  cancelRun: (id: string, reason: string, resumeQueue: false) => Promise<unknown>;
  recordQueueTransitionEvent: (event: Parameters<typeof import("./heartbeat.js").recordHeartbeatQueueTransitionEvent>[1]) => Promise<void>;
  publishLiveEvent: typeof import("./live-events.js").publishLiveEvent;
  setWakeupStatus: (id: string | null, status: "claimed", patch: { claimedAt: Date }) => Promise<unknown>;
};

/** Cancellation is awaited after root rollback; only a real correction rejection enables queue refresh. */
export async function claimQueuedRunWithRecoveryGuard(deps: ClaimEffects, run: Run): Promise<ClaimOutcome> {
  if (run.status !== "queued") return { kind: "claimed", run };
  const claimedAt = new Date();
  let outcome: Awaited<ReturnType<typeof guardedClaim>> | ExecutionBoundary<Run | null>;
  try {
    outcome = deps.sharedAdmission
      ? await guardedC5Claim(deps.db, run, claimedAt, deps.sharedAdmission)
      : await guardedClaim(deps.db, run, claimedAt);
  }
  catch (error) {
    if (isQaCorrectionRootOwnerRequired(error)
      || (is(deps.db, PgTransaction) && error instanceof QaCorrectionClaimRejected)) throw error;
    if (deps.sharedAdmission && error instanceof QaRemediationAdmissionHold) {
      return { kind: (isClaimDiscoveryHold(error, deps.db, captureQaCorrectionExecutionIdentity(run))
        || isC5PreInvocationRollback(error, deps.db, captureQaCorrectionExecutionIdentity(run), "claim")) ? "c5_held" : "c5_unknown" };
    }
    await deps.cancelRun(run.id, error instanceof Error ? error.message : "Heartbeat claim refused", false);
    return { kind: error instanceof QaCorrectionClaimRejected ? "correction_rejected" : "not_claimed" };
  }
  if (outcome.kind === "c5_held_not_invoked") {
    try { readC5NotInvokedProof(outcome.proof, deps.db, captureQaCorrectionExecutionIdentity(run), "claim"); }
    catch { return { kind: "c5_unknown" }; }
    return { kind: "c5_held" };
  }
  if (outcome.kind === "root_deferred") return { kind: "root_deferred" };
  if (outcome.kind === "not_claimed") return { kind: "not_claimed" };
  if (outcome.kind !== "performed") return outcome;
  const claimed = outcome.value;
  if (!claimed) return { kind: "not_claimed" };
  // [Task 6C] queue_run_started event (queued→running transition)
  await deps.recordQueueTransitionEvent({
    companyId: claimed.companyId,
    heartbeatRunId: claimed.id,
    wakeupRequestId: claimed.wakeupRequestId,
    issueId: claimed.issueId,
    eventType: "queue_run_started",
    layer: "heartbeat",
    decision: "running",
    reason: "claim_succeeded",
    reasonCode: "claim_succeeded",
    idempotencyKey: `queue-run-started:${claimed.id}`,
  });

  deps.publishLiveEvent({
    companyId: claimed.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: claimed.id,
      agentId: claimed.agentId,
      status: claimed.status,
      invocationSource: claimed.invocationSource,
      triggerDetail: claimed.triggerDetail,
      error: claimed.error ?? null,
      errorCode: claimed.errorCode ?? null,
      startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
      finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
    },
  });

  await deps.setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
  return { kind: "claimed", run: claimed };
}

type QueueClaims = {
  c5QueueOptIn: boolean;
  select: (slots: number, attempted: string[]) => Promise<Run[]>;
  promote: (slots: number) => Promise<Run[]>;
  claim: (run: Run) => Promise<ClaimOutcome>;
  publish: (run: Run) => void;
};
/** Caller holds the agent-start lock; finite C5 queue progress is limited to its explicit owner opt-in. */
export async function claimAvailableHeartbeatRuns(deps: QueueClaims, slots: number): Promise<Run[]> {
  const claimed: Run[] = [], attempted = new Set<string>();
  const c5QueueOptIn = deps.c5QueueOptIn;
  const take = async (runs: Run[]) => {
    let retryQueue = false, uncertain = false;
    for (const run of runs) {
      if (attempted.has(run.id)) continue;
      attempted.add(run.id);
      const result = await deps.claim(run);
      if (result.kind === "claimed") claimed.push(result.run);
      if (result.kind === "correction_rejected" || (c5QueueOptIn && result.kind === "c5_held")) retryQueue = true;
      if (result.kind === "root_deferred" || result.kind === "c5_unknown"
        || (c5QueueOptIn && result.kind === "not_claimed")
        || (!c5QueueOptIn && result.kind === "c5_held")) {
        uncertain = true;
        break;
      }
    }
    return { retryQueue, uncertain };
  };
  let queued = await deps.select(slots, []);
  for (;;) {
    const queuedResult = await take(queued);
    if (claimed.length >= slots || queuedResult.uncertain) break;
    if (queuedResult.retryQueue) {
      queued = await deps.select(slots - claimed.length, [...attempted]);
      if (queued.length) continue;
    }
    const promoted = await deps.promote(slots - claimed.length);
    for (const run of promoted) deps.publish(run);
    const promotedResult = await take(promoted);
    if (claimed.length >= slots || promotedResult.uncertain || !promotedResult.retryQueue) break;
    queued = await deps.select(slots - claimed.length, [...attempted]);
  }
  return claimed;
}
