import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentWakeupRequests, heartbeatRuns, issueWorkProducts, issues, missions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared";
import { producerAttemptDetail } from "./work-products/producer-attempt.js";
import { resolveWorkProductLocalFilePath } from "./work-products/producer-seal.js";
import type { QaRemediationPreparation } from "./workflow/control-flow/qa-remediation-preparation-contract.js";

export const HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE = "heartbeat_actual_drained_v1";
export const HEARTBEAT_ACTUAL_DRAIN_SCHEMA = "workflow.heartbeat-actual-drain.v1";
const uuid = z.string().uuid(), count = z.number().int().safe().nonnegative(), text = z.string().min(1);

const identitySchema = z.object({
  companyId: uuid, missionId: uuid, workflowRunId: uuid, dispatchAuthorityVersion: count,
  workflowStepRunId: uuid, stepId: text, issueId: uuid, heartbeatRunId: uuid, wakeupRequestId: uuid,
  executionGeneration: count, retryCount: count, iterationIndex: count, executionScopeKind: text,
  executionEpoch: count, executionToken: text, executorOwnerId: text, ownerLeaseEpoch: count,
  ownerLeaseToken: text, retryOfRunId: uuid.nullable(), processLossRetryCount: count,
  ancestry: z.object({ rootHeartbeatRunId: uuid, rootWakeupRequestId: uuid }).strict(),
}).strict();
export type HeartbeatActualDrainIdentity = z.infer<typeof identitySchema>;

const payloadSchema = z.object({
  schemaVersion: z.literal(HEARTBEAT_ACTUAL_DRAIN_SCHEMA), identity: identitySchema,
  actual: z.object({ outcome: z.enum(["fulfilled", "rejected"]), observedAt: z.string().datetime({ offset: true }) }).strict(),
  cleanup: z.object({
    runtimeServicesRelease: z.object({ called: z.literal(true), succeeded: z.literal(true) }).strict(),
    heartbeatSettlement: z.object({ called: z.literal(true), succeeded: z.literal(true) }).strict(),
    resources: z.object({ workspaceOperationsSettled: z.literal(true), runtimeServicesStopped: z.literal(true),
      missionRuntimeIdle: z.literal(true) }).strict(),
  }).strict(),
}).strict();
type Payload = z.infer<typeof payloadSchema>;
type Step = typeof workflowStepRuns.$inferSelect;
type Heartbeat = typeof heartbeatRuns.$inferSelect;
type Actual<T> = { outcome: "fulfilled"; value: T; observedAt: Date } | { outcome: "rejected"; error: unknown; observedAt: Date };

/** Observes only the Promise returned by adapter.execute; no outer guard promise is accepted. */
export function createHeartbeatActualObservation<T>() {
  let invoked = false, outcomePromise: Promise<Actual<T>> | null = null;
  return {
    invoke(start: () => Promise<T>): Promise<T> {
      if (invoked) throw new Error("heartbeat_actual_adapter_invoked_twice");
      invoked = true;
      let actual: Promise<T>;
      try { actual = start(); } catch (error) { invoked = false; throw error; }
      if (!actual || typeof actual.then !== "function") { invoked = false; throw new Error("heartbeat_actual_adapter_promise_missing"); }
      outcomePromise = new Promise<Actual<T>>(resolve => {
        void actual.then(value => resolve({ outcome: "fulfilled", value, observedAt: new Date() }),
          error => resolve({ outcome: "rejected", error, observedAt: new Date() }));
      });
      void actual.catch(() => {});
      return actual;
    },
    async awaitSettled(): Promise<Actual<T> | null> { return outcomePromise ? outcomePromise : null; },
    wasInvoked(): boolean { return invoked; },
  };
}

function sameRun(left: Heartbeat, right: Heartbeat) {
  return left.id === right.id && left.companyId === right.companyId && left.agentId === right.agentId
    && left.issueId === right.issueId && left.wakeupRequestId === right.wakeupRequestId
    && left.workflowStepRunId === right.workflowStepRunId
    && left.workflowExecutionGeneration === right.workflowExecutionGeneration
    && left.executionScopeKind === right.executionScopeKind && left.executionEpoch === right.executionEpoch
    && left.executionToken === right.executionToken && left.executorOwnerId === right.executorOwnerId
    && left.executorOwnerLeaseEpoch === right.executorOwnerLeaseEpoch
    && left.executorOwnerLeaseToken === right.executorOwnerLeaseToken && left.retryOfRunId === right.retryOfRunId
    && left.processLossRetryCount === right.processLossRetryCount;
}
function stepAttempt(step: Step) {
  return { stepRunId: step.id, stepId: step.stepId, issueId: step.issueId,
    executionGeneration: step.executionGeneration, retryCount: step.retryCount, iterationIndex: step.iterationIndex };
}
function key(identity: HeartbeatActualDrainIdentity) {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `heartbeat-actual-drained:v1:${identity.heartbeatRunId}:${digest}`;
}
function readContextId(context: unknown, name: string) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const value = (context as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value : null;
}

async function identityFromCurrent(db: Pick<Db, "select">, heartbeat: Heartbeat, workflowRunId: string): Promise<HeartbeatActualDrainIdentity | null> {
  if (!heartbeat.wakeupRequestId || !heartbeat.issueId || !heartbeat.workflowStepRunId
    || heartbeat.workflowExecutionGeneration === null || !heartbeat.startedAt || !heartbeat.executionScopeKind
    || heartbeat.executionEpoch === null || !heartbeat.executionToken || !heartbeat.executorOwnerId
    || heartbeat.executorOwnerLeaseEpoch === null || !heartbeat.executorOwnerLeaseToken) return null;
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heartbeat.workflowStepRunId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
  if (!wake || !step || !run || wake.companyId !== heartbeat.companyId || wake.agentId !== heartbeat.agentId
    || wake.issueId !== heartbeat.issueId || wake.workflowRunId !== workflowRunId
    || wake.workflowStepRunId !== step.id || wake.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
    || wake.runId !== heartbeat.id || wake.status === "coalesced"
    || step.workflowRunId !== workflowRunId || step.issueId !== heartbeat.issueId
    || step.executionGeneration !== heartbeat.workflowExecutionGeneration || run.companyId !== heartbeat.companyId
    || run.missionId !== wake.missionId || run.missionId === null || step.retryCount === null || step.iterationIndex === null) return null;
  const attempt = await producerAttemptDetail(db, heartbeat, step);
  if (attempt.retryCount !== step.retryCount || attempt.iterationIndex !== step.iterationIndex) return null;
  return identitySchema.parse({ companyId: heartbeat.companyId, missionId: run.missionId,
    workflowRunId: run.id, dispatchAuthorityVersion: run.dispatchAuthorityVersion,
    workflowStepRunId: step.id, stepId: step.stepId, issueId: step.issueId,
    heartbeatRunId: heartbeat.id, wakeupRequestId: wake.id, executionGeneration: heartbeat.workflowExecutionGeneration,
    retryCount: attempt.retryCount, iterationIndex: attempt.iterationIndex,
    executionScopeKind: heartbeat.executionScopeKind, executionEpoch: heartbeat.executionEpoch,
    executionToken: heartbeat.executionToken, executorOwnerId: heartbeat.executorOwnerId,
    ownerLeaseEpoch: heartbeat.executorOwnerLeaseEpoch, ownerLeaseToken: heartbeat.executorOwnerLeaseToken,
    retryOfRunId: heartbeat.retryOfRunId, processLossRetryCount: heartbeat.processLossRetryCount,
    ancestry: { rootHeartbeatRunId: attempt.rootHeartbeatRunId, rootWakeupRequestId: attempt.rootWakeupRequestId } });
}

/** Freeze the workflow-linked actual attempt before adapter invocation; failure only withholds this evidence. */
export async function freezeHeartbeatActualDrainIdentity(db: Pick<Db, "select">, run: Heartbeat,
  context: unknown): Promise<HeartbeatActualDrainIdentity | null> {
  const workflowRunId = readContextId(context, "workflowRunId");
  if (!workflowRunId) return null;
  const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  if (!current || !sameRun(current, run)) return null;
  return identityFromCurrent(db, current, workflowRunId);
}

function matchesIdentity(run: Heartbeat, identity: HeartbeatActualDrainIdentity) {
  return run.id === identity.heartbeatRunId && run.companyId === identity.companyId && run.issueId === identity.issueId
    && run.wakeupRequestId === identity.wakeupRequestId && run.workflowStepRunId === identity.workflowStepRunId
    && run.workflowExecutionGeneration === identity.executionGeneration && run.executionScopeKind === identity.executionScopeKind
    && run.executionEpoch === identity.executionEpoch && run.executionToken === identity.executionToken
    && run.executorOwnerId === identity.executorOwnerId && run.executorOwnerLeaseEpoch === identity.ownerLeaseEpoch
    && run.executorOwnerLeaseToken === identity.ownerLeaseToken && run.retryOfRunId === identity.retryOfRunId
    && run.processLossRetryCount === identity.processLossRetryCount;
}
function exactEvent(row: typeof workflowTransitionEvents.$inferSelect, identity: HeartbeatActualDrainIdentity,
  expectedKey: string, expectedOutcome: "fulfilled" | "rejected") {
  const parsed = payloadSchema.safeParse(row.payload);
  return parsed.success && row.companyId === identity.companyId && row.missionId === identity.missionId
    && row.workflowRunId === identity.workflowRunId && row.workflowStepRunId === identity.workflowStepRunId
    && row.issueId === identity.issueId && row.heartbeatRunId === identity.heartbeatRunId
    && row.executionGeneration === identity.executionGeneration && row.eventType === HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE
    && row.layer === "heartbeat" && row.reasonCode === "actual_drain_observed" && row.idempotencyKey === expectedKey
    && row.dispatchOwnerHeartbeatRunId === identity.heartbeatRunId && row.executorOwnerId === identity.executorOwnerId
    && isDeepStrictEqual(parsed.data.identity, identity)
    && parsed.data.actual.outcome === expectedOutcome
    && parsed.data.cleanup.runtimeServicesRelease.succeeded && parsed.data.cleanup.heartbeatSettlement.succeeded
    && Object.values(parsed.data.cleanup.resources).every(Boolean);
}

export type ActualDrainWrite = { outcome: "written" | "existing"; evidenceEventId: string }
  | { outcome: "held"; reason: string };

/** Durable end fact only; cleanup and resource observations are supplied by the real executeRun finally path. */
export async function writeHeartbeatActualDrain(db: Db, identity: HeartbeatActualDrainIdentity | null,
  actual: Actual<unknown> | null, cleanup: { releaseCalled: boolean; releaseSucceeded: boolean;
    settlementCalled: boolean; settlementSucceeded: boolean; resources: Record<string, boolean> }): Promise<ActualDrainWrite> {
  if (!identity || !actual) return { outcome: "held", reason: "actual_or_workflow_identity_unobserved" };
  if (!cleanup.releaseCalled || !cleanup.releaseSucceeded || !cleanup.settlementCalled || !cleanup.settlementSucceeded
    || !Object.values(cleanup.resources).length || !Object.values(cleanup.resources).every(Boolean)) {
    return { outcome: "held", reason: "cleanup_or_resource_proof_unobserved" };
  }
  const payload: Payload = payloadSchema.parse({ schemaVersion: HEARTBEAT_ACTUAL_DRAIN_SCHEMA, identity,
    actual: { outcome: actual.outcome, observedAt: actual.observedAt.toISOString() },
    cleanup: { runtimeServicesRelease: { called: true, succeeded: true }, heartbeatSettlement: { called: true, succeeded: true },
      resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true } } });
  const idempotencyKey = key(identity);
  return await db.transaction(async tx => {
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, identity.missionId),
      eq(missions.companyId, identity.companyId))).for("no key update");
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, identity.workflowRunId),
      eq(workflowRuns.companyId, identity.companyId))).for("no key update");
    if (!mission || !run || run.missionId !== identity.missionId || run.dispatchAuthorityVersion !== identity.dispatchAuthorityVersion) {
      return { outcome: "held" as const, reason: "workflow_scope_changed" };
    }
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, identity.issueId),
      eq(issues.companyId, identity.companyId))).for("no key update");
    const [step] = await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, identity.workflowStepRunId),
      eq(workflowStepRuns.workflowRunId, identity.workflowRunId))).for("no key update");
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, identity.heartbeatRunId),
      eq(heartbeatRuns.companyId, identity.companyId))).for("no key update");
    if (!issue || !step || !heartbeat || issue.id !== step.issueId || !matchesIdentity(heartbeat, identity)
      || !isDeepStrictEqual(stepAttempt(step), { stepRunId: identity.workflowStepRunId,
        stepId: identity.stepId, issueId: identity.issueId, executionGeneration: identity.executionGeneration,
        retryCount: identity.retryCount, iterationIndex: identity.iterationIndex })) {
      return { outcome: "held" as const, reason: "current_attempt_changed" };
    }
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, identity.wakeupRequestId),
      eq(agentWakeupRequests.companyId, identity.companyId)));
    if (!wake || wake.runId !== identity.heartbeatRunId || wake.workflowRunId !== identity.workflowRunId
      || wake.workflowStepRunId !== identity.workflowStepRunId || wake.issueId !== identity.issueId
      || wake.workflowExecutionGeneration !== identity.executionGeneration) {
      return { outcome: "held" as const, reason: "original_wakeup_changed" };
    }
    const ancestry = await producerAttemptDetail(tx, heartbeat, step).catch(() => null);
    if (!ancestry || ancestry.retryCount !== identity.retryCount || ancestry.iterationIndex !== identity.iterationIndex
      || ancestry.rootHeartbeatRunId !== identity.ancestry.rootHeartbeatRunId
      || ancestry.rootWakeupRequestId !== identity.ancestry.rootWakeupRequestId) {
      return { outcome: "held" as const, reason: "original_attempt_unproven" };
    }
    const inserted = await tx.insert(workflowTransitionEvents).values({ companyId: identity.companyId, missionId: identity.missionId,
      workflowRunId: identity.workflowRunId, workflowStepRunId: identity.workflowStepRunId, issueId: identity.issueId,
      heartbeatRunId: identity.heartbeatRunId, dispatchOwnerHeartbeatRunId: identity.heartbeatRunId,
      executorOwnerId: identity.executorOwnerId, executionGeneration: identity.executionGeneration,
      eventType: HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE, layer: "heartbeat", reason: "actual_adapter_settled_and_cleaned",
      reasonCode: "actual_drain_observed", idempotencyKey, payload, createdAt: new Date() }).onConflictDoNothing()
      .returning({ id: workflowTransitionEvents.id });
    const rows = await tx.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, identity.companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey)));
    if (rows.length !== 1 || !exactEvent(rows[0]!, identity, idempotencyKey, actual.outcome)) {
      return { outcome: "held" as const, reason: "durable_event_missing_or_malformed" };
    }
    return { outcome: inserted.length ? "written" as const : "existing" as const,
      evidenceEventId: rows[0]!.id };
  });
}

export type ActualDrainRead = { kind: "proven"; heartbeatIds: readonly string[]; evidenceIds: readonly string[] }
  | { kind: "held"; reason: string; targetPaths: readonly string[] };

/** Read-only P→H→T join. A receipt proves only an actual end and never publication authority. */
export async function readQaRemediationActualDrain(db: Pick<Db, "select">, preparation: QaRemediationPreparation,
  producer: Step): Promise<ActualDrainRead> {
  const paths = preparation.files.map(file => file.path), hold = (reason: string): ActualDrainRead => ({ kind: "held", reason, targetPaths: paths });
  if (!isDeepStrictEqual(stepAttempt(producer), { stepRunId: preparation.producer.stepRunId,
    stepId: preparation.producer.stepId, issueId: preparation.producer.issueId,
    executionGeneration: preparation.producer.executionGeneration, retryCount: preparation.producer.retryCount,
    iterationIndex: preparation.producer.iterationIndex })) return hold("producer_attempt_mismatch");
  const products = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, preparation.companyId),
    eq(issueWorkProducts.issueId, preparation.producer.issueId), eq(issueWorkProducts.status, "active")));
  const matched = paths.map(target => products.filter(product => resolveWorkProductLocalFilePath(product) === target));
  if (matched.some(rows => rows.length !== 1)) return hold("active_target_registration_missing_or_ambiguous");
  let actualHeartbeatId: string | null = null;
  const owners: Heartbeat[] = [];
  for (const product of matched.flat()) {
    if (!product.createdByRunId || !["local", "local_file"].includes(product.provider)) return hold("target_owner_or_provider_missing");
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success || parsed.data.companyId !== preparation.companyId || parsed.data.missionId !== preparation.missionId
      || parsed.data.workflowRunId !== preparation.workflowRunId || parsed.data.stepRunId !== preparation.producer.stepRunId
      || parsed.data.stepId !== preparation.producer.stepId || parsed.data.executionGeneration !== preparation.producer.executionGeneration
      || parsed.data.retryCount !== preparation.producer.retryCount || parsed.data.iterationIndex !== preparation.producer.iterationIndex
      || parsed.data.heartbeatRunId !== product.createdByRunId) return hold("target_provenance_malformed_or_mismatched");
    if (actualHeartbeatId && actualHeartbeatId !== product.createdByRunId) return hold("targets_have_multiple_actual_owners");
    actualHeartbeatId = product.createdByRunId;
    const [heartbeat] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actualHeartbeatId),
      eq(heartbeatRuns.companyId, preparation.companyId)));
    if (!heartbeat || heartbeat.workflowStepRunId !== producer.id
      || heartbeat.workflowExecutionGeneration !== producer.executionGeneration) return hold("target_actual_attempt_mismatch");
    owners.push(heartbeat);
  }
  if (!actualHeartbeatId || !owners.length) return hold("actual_owner_unavailable");
  const identity = await identityFromCurrent(db, owners[0]!, preparation.workflowRunId).catch(() => null);
  if (!identity || identity.missionId !== preparation.missionId || identity.workflowStepRunId !== producer.id
    || identity.stepId !== producer.stepId || identity.retryCount !== preparation.producer.retryCount
    || identity.iterationIndex !== preparation.producer.iterationIndex) return hold("actual_identity_unproven");
  const events = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, identity.companyId), eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId),
    eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId),
    eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE)));
  const idempotencyKey = key(identity);
  if (events.length !== 1 || !exactEvent(events[0]!, identity, idempotencyKey, "fulfilled")) {
    return hold("actual_drain_event_missing_or_malformed");
  }
  return { kind: "proven", heartbeatIds: [identity.heartbeatRunId], evidenceIds: [events[0]!.id] };
}
