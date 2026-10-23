import { and, eq, inArray, is, or } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, operatorDecisionContinuations, operatorDecisions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isQaCorrectionRootOwnerRequired } from "./issue-assignment-wakeup.js";
import { QaCorrectionClaimRejected, withQaCorrectionClaimRoot } from "./workflow/control-flow/qa-correction-claim-root.js";
import { conflict } from "../errors.js";
import { budgetService } from "./budgets.js";
import { assertRunNotReplaced } from "./workflow/run-replacement-guard.js";
import { budgetBlockers } from "./workflow/resume/preview-facts.js";
import { assertMissionRuntimeAcceptsWork } from "./missions/mission-runtime-manager.js";
import { claimQueuedHeartbeatRun } from "./heartbeat-finalization/shadow-writes.js";
import { preparePauseChildAdmission, assertCurrentPauseChild, type PauseChildAdmission } from "./heartbeat-pause-admission.js";
import { assertOwnerHumanDecisionCurrent, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "./operator-decision-currentness.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "./operator-decision-continuation-store.js";
import type { OwnerHumanTx } from "./missions/owner-human-request-contract.js";

type Scope = {
  companyId: string; agentId: string;
  issueId?: string | null; missionId?: string | null;
  workflowRunId?: string | null; workflowStepRunId?: string | null;
  contextSnapshot?: unknown; wakeupRequestId?: string | null; idempotencyKey?: string | null;
  source?: string | null; reason?: string | null; payload?: unknown;
  requestedByActorType?: string | null; requestedByActorId?: string | null;
  operatorDecisionInitialAdmission?: boolean; operatorDecisionOnly?: boolean;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

const resolutionRef = z.object({ operatorDecisionId: z.string().uuid(), options: z.array(z.object({
  id: z.string(), label: z.string(), description: z.string().nullable(),
}).strict()) }).strict();
function sameJson(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function readDeliveryMarker(input: Scope, context: Record<string, unknown>) {
  if (!input.operatorDecisionInitialAdmission) return null;
  const payload = record(input.payload), rawPayload = payload.paperclipOperatorDecisionResolution,
    rawContext = context.paperclipOperatorDecisionResolution;
  const marked = input.idempotencyKey?.startsWith(OPERATOR_DECISION_WAKE_PREFIX) || input.reason === "operator_decision_resolved"
    || payload.kind === "operator_decision_resolution" || context.wakeReason === "operator_decision_resolved"
    || payload.operatorDecisionId !== undefined || context.operatorDecisionId !== undefined || rawPayload !== undefined || rawContext !== undefined;
  if (!marked) return null;
  const keyId = input.idempotencyKey?.startsWith(OPERATOR_DECISION_WAKE_PREFIX)
    ? input.idempotencyKey.slice(OPERATOR_DECISION_WAKE_PREFIX.length).split(":g")[0] : null;
  const ids = [...new Set([payload.operatorDecisionId, context.operatorDecisionId, record(rawPayload).operatorDecisionId,
    record(rawContext).operatorDecisionId, keyId].filter((value): value is string => typeof value === "string" && value.length > 0))];
  return { ids, rawPayload, rawContext };
}
async function assertOperatorDecisionDelivery(db: Db, input: Scope, marker: ReturnType<typeof readDeliveryMarker>) {
  if (!marker) return false;
  const validIds = marker.ids.filter(id => z.string().uuid().safeParse(id).success);
  const decisions = validIds.length ? await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId), inArray(operatorDecisions.id, validIds))) : [];
  if (!marker.ids.length || validIds.length !== marker.ids.length || !decisions.length) throw conflict("operator_decision_delivery_reference_invalid");
  const ownerCards = decisions.filter(row => row.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE);
  if (!ownerCards.length) return false;
  const decision = ownerCards[0]!, decisionId = decision.id;
  const fromPayload = resolutionRef.safeParse(marker.rawPayload), fromContext = resolutionRef.safeParse(marker.rawContext);
  if (ownerCards.length !== 1 || marker.ids.some(id => id !== decisionId) || !fromPayload.success
    || !fromContext.success || !sameJson(fromPayload.data, fromContext.data)) throw conflict("operator_decision_delivery_reference_invalid");
  const resolution = fromPayload.data;
  await assertOwnerHumanDecisionCurrent(db as unknown as OwnerHumanTx, decision);
  const [continuation] = await db.select().from(operatorDecisionContinuations).where(and(
    eq(operatorDecisionContinuations.companyId, input.companyId), eq(operatorDecisionContinuations.operatorDecisionId, decisionId))).for("update");
  const payload = record(input.payload), context = record(input.contextSnapshot);
  const selectedOptionIds = decision.result?.selectedOptionIds ?? [];
  const byId = new Map(decision.definition.options.map(option => [option.id, option]));
  const expectedResolution = { operatorDecisionId: decision.id, options: selectedOptionIds.map(id => {
    const option = byId.get(id); return option ? { id: option.id, label: option.label, description: option.description }
      : { id, label: id, description: null }; }) };
  const expectedKey = continuation
    ? `${OPERATOR_DECISION_WAKE_PREFIX}${decisionId}:g${continuation.generation}:a${continuation.attemptCount}` : null;
  if (decision.status !== "resolved" || !decision.result || !sameJson(resolution, expectedResolution)
    || payload.operatorDecisionId !== decisionId || context.operatorDecisionId !== decisionId
    || input.missionId !== decision.sourceContext.missionId || context.missionId !== decision.sourceContext.missionId
    || payload.actionId !== decision.result.actionId || !sameJson(payload.selectedOptionIds, selectedOptionIds)
    || context.wakeReason !== "operator_decision_resolved"
    || !continuation || continuation.state !== "leased" || continuation.targetAgentId !== input.agentId
    || !continuation.issueId || continuation.issueId !== input.issueId || continuation.issueId !== text(payload.issueId)
    || continuation.issueId !== text(context.issueId) || continuation.idempotencyKey !== expectedKey
    || input.idempotencyKey !== expectedKey || input.source !== "automation"
    || input.reason !== "operator_decision_resolved" || payload.kind !== "operator_decision_resolution"
    || input.requestedByActorType !== "user" || input.requestedByActorId !== decision.resolvedByUserId) {
    throw conflict("operator_decision_delivery_identity_mismatch");
  }
  return true;
}

/** OR all identity paths; owner issue membership alone is not execution linkage. Caller owns the transaction. */
export async function assertHeartbeatRecoveryAdmission(db: Db, input: Scope) {
  const context = record(input.contextSnapshot);
  const deliveryMarker = readDeliveryMarker(input, context);
  const ownerDelivery = deliveryMarker ? await assertOperatorDecisionDelivery(db, input, deliveryMarker) : false;
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
async function guardedClaim(db: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date) {
  let pause: PauseChildAdmission | null = null;
  return withQaCorrectionClaimRoot(db, run, async t => {
    pause = await preparePauseChildAdmission(t, run, missionId => assertHeartbeatRecoveryAdmission(t, { ...run, missionId }));
  }, async t => {
    const [agent] = await t.select().from(agents).where(eq(agents.id, run.agentId));
    if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("Cancelled because the agent is not invokable");
    const context = record(run.contextSnapshot);
    const block = await budgetService(t).getInvocationBlock(run.companyId, run.agentId, { issueId: text(context.issueId), projectId: text(context.projectId) });
    if (block) throw conflict(block.reason);
    const missionId = text(context.missionId);
    if (missionId) await assertMissionRuntimeAcceptsWork(t, { companyId: run.companyId, missionId });
    await assertCurrentPauseChild(t, run, pause);
    return claimQueuedHeartbeatRun(t, run, claimedAt);
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

type Run = typeof heartbeatRuns.$inferSelect;
export type ClaimOutcome =
  | { kind: "claimed"; run: Run }
  | { kind: "not_claimed" }
  | { kind: "root_deferred" }
  | { kind: "correction_rejected" };
type ClaimEffects = {
  db: Db;
  cancelRun: (id: string, reason: string, resumeQueue: false) => Promise<unknown>;
  recordQueueTransitionEvent: (event: Parameters<typeof import("./heartbeat.js").recordHeartbeatQueueTransitionEvent>[1]) => Promise<void>;
  publishLiveEvent: typeof import("./live-events.js").publishLiveEvent;
  setWakeupStatus: (id: string | null, status: "claimed", patch: { claimedAt: Date }) => Promise<unknown>;
};

/** Cancellation is awaited after root rollback; only a real correction rejection enables queue refresh. */
export async function claimQueuedRunWithRecoveryGuard(deps: ClaimEffects, run: Run): Promise<ClaimOutcome> {
  if (run.status !== "queued") return { kind: "claimed", run };
  const claimedAt = new Date();
  let outcome: Awaited<ReturnType<typeof guardedClaim>>;
  try { outcome = await guardedClaim(deps.db, run, claimedAt); }
  catch (error) {
    if (isQaCorrectionRootOwnerRequired(error)
      || (is(deps.db, PgTransaction) && error instanceof QaCorrectionClaimRejected)) throw error;
    await deps.cancelRun(run.id, error instanceof Error ? error.message : "Heartbeat claim refused", false);
    return { kind: error instanceof QaCorrectionClaimRejected ? "correction_rejected" : "not_claimed" };
  }
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
  select: (slots: number, attempted: string[]) => Promise<Run[]>;
  promote: (slots: number) => Promise<Run[]>;
  claim: (run: Run) => Promise<ClaimOutcome>;
  publish: (run: Run) => void;
};
/** Caller holds the existing agent-start lock. Removed rejected rows, rather than a new limit, bound progress. */
export async function claimAvailableHeartbeatRuns(deps: QueueClaims, slots: number): Promise<Run[]> {
  const claimed: Run[] = [], attempted = new Set<string>();
  const take = async (runs: Run[]) => {
    let rejected = false;
    for (const run of runs) {
      if (attempted.has(run.id)) continue;
      attempted.add(run.id);
      const result = await deps.claim(run);
      if (result.kind === "claimed") claimed.push(result.run);
      if (result.kind === "correction_rejected") rejected = true;
    }
    return rejected;
  };
  let queued = await deps.select(slots, []);
  for (;;) {
    const rejected = await take(queued);
    if (claimed.length >= slots) break;
    if (rejected) {
      queued = await deps.select(slots - claimed.length, [...attempted]);
      if (queued.length) continue;
    }
    const promoted = await deps.promote(slots - claimed.length);
    for (const run of promoted) deps.publish(run);
    if (!await take(promoted) || claimed.length >= slots) break;
    queued = await deps.select(slots - claimed.length, [...attempted]);
  }
  return claimed;
}
