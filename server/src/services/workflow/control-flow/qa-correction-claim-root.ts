import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, missions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { conflict } from "../../../errors.js";
import { asBoolean, parseObject } from "../../../adapters/utils.js";
import { isQaCorrectionRootOwnerRequired, registerQaCorrectionRootDrain } from "../../issue-assignment-wakeup.js";
import { lockQualityAttemptBudget } from "../../quality/retry-budget.js";
import { QaRemediationAdmissionHold, withQaRemediationSharedAdmission,
  type QaCorrectionExecutionBoundary, type QaCorrectionExecutionIdentity, type QaCorrectionExecutionInvokeOnce,
  type QaCorrectionExecutionScope, type QaCorrectionOriginalWakeIdentity, type QaCorrectionReplacementAuthority,
  type QaRemediationAdmissionContext, type QaRemediationSharedAdmissionRuntime }
  from "./qa-remediation-admission-root.js";
import { hasPendingQaRemediationForRun, discoverQaRemediationWorkflowScope } from "./qa-remediation-admission-root.js";
import { producerAttempt } from "../../work-products/producer-attempt.js";
import { readAdmittedWorkflowIdentity } from "../../heartbeat-finalization/producer-identity.js";
import { readWorkflowAttemptProof } from "../../heartbeat-finalization/workflow-attempt-proof.js";
import { pauseDeliveryRun, provePauseDeliveryAttempt, type PauseDeliveryObservation } from "../../heartbeat-pause-admission.js";
import { readQaCorrectionWakeRef } from "../../work-products/qa-correction-producer-attempt.js";
import type { QaCorrectionFollowupRef } from "./qa-correction-contract.js";
import { readIssuedQaCorrectionFollowupForAttempt, type IssuedQaCorrection } from "./qa-correction-reader.js";
import { createQaCorrectionHistorySession } from "./qa-correction-history-session.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup,
  readQaCorrectionFollowupDb } from "./qa-correction-followup.js";
import type { DeliveryHistory, DeliveryTx, DeliveryWake } from "./qa-correction-delivery-receipt.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Connection = Pick<Db, "select">;
type Boundary<T> = { kind: "performed"; value: T } | { kind: "root_deferred" } | { kind: "not_claimed" };
const requireClaim = (ok: unknown) => {
  if (!ok) throw conflict("qa_correction_claim_relation_changed");
};
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const identity = (r: Run) => [r.id, r.companyId, r.agentId, r.issueId, r.wakeupRequestId,
  r.retryOfRunId, r.workflowStepRunId, r.workflowExecutionGeneration];
const owner = (r: typeof issues.$inferSelect) => [r.id, r.executionRunId, r.checkoutRunId,
  r.executionAgentNameKey, r.executionLockedAt];

const discoveryHolds = new WeakMap<object, { db: Db; identity: QaCorrectionExecutionIdentity }>();
export function isClaimDiscoveryHold(error: unknown, db: Db, identity: QaCorrectionExecutionIdentity): boolean {
  const proof = error instanceof QaRemediationAdmissionHold ? discoveryHolds.get(error) : undefined;
  return proof?.db === db && same(proof.identity, identity);
}

export class QaCorrectionClaimRejected extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "qa_correction_claim_refused", { cause });
  }
}

export type QaCorrectionExecutionBox<T> = Readonly<{ result: Promise<T> }>;
export type QaCorrectionExecutionRootInput<T> = Readonly<{
  phase: "claim" | "adapter_start";
  admit: (db: Db, run: Run, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext) => Promise<void>;
  work: (db: Db, run: Run, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext,
    invokeOnce: QaCorrectionExecutionInvokeOnce) => Promise<T>;
  sharedAdmission: QaRemediationSharedAdmissionRuntime;
}>;

export function captureQaCorrectionExecutionIdentity(run: Run): QaCorrectionExecutionIdentity {
  const nullableTextFields = [run.issueId, run.wakeupRequestId, run.workflowStepRunId, run.retryOfRunId,
    run.executionScopeKind, run.executionToken, run.executorOwnerId, run.executorOwnerLeaseToken];
  const nullableIntegerFields = [run.workflowExecutionGeneration, run.executionEpoch, run.executorOwnerLeaseEpoch];
  const ownerTimestamps = [run.executorOwnerLeaseExpiresAt, run.executorOwnerAcknowledgedAt, run.executorOwnerReleasedAt];
  if (![run.id, run.companyId, run.agentId].every(value => typeof value === "string" && value.trim())
    || nullableTextFields.some(value => value !== null && (typeof value !== "string" || !value.trim()))
    || nullableIntegerFields.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
    || ownerTimestamps.some(value => value !== null && !(value instanceof Date && Number.isFinite(value.getTime())))
    || !Number.isSafeInteger(run.processLossRetryCount) || run.processLossRetryCount < 0) {
    throw new QaRemediationAdmissionHold("execution_identity_untyped", []);
  }
  const ownerFields = [run.executionScopeKind, run.executionEpoch, run.executionToken, run.executorOwnerId,
    run.executorOwnerLeaseEpoch, run.executorOwnerLeaseToken];
  if (ownerFields.some(value => value !== null) && ownerFields.some(value => value === null)) {
    throw new QaRemediationAdmissionHold("execution_owner_identity_untyped", []);
  }
  if (ownerFields.every(value => value === null) && ownerTimestamps.some(value => value !== null)) {
    throw new QaRemediationAdmissionHold("execution_owner_identity_untyped", []);
  }
  if (ownerFields.some(value => value !== null) && run.executorOwnerLeaseExpiresAt === null) {
    throw new QaRemediationAdmissionHold("execution_owner_lease_untyped", []);
  }
  return Object.freeze({
    heartbeatRunId: run.id,
    companyId: run.companyId,
    agentId: run.agentId,
    issueId: run.issueId,
    wakeupRequestId: run.wakeupRequestId,
    workflowStepRunId: run.workflowStepRunId,
    workflowExecutionGeneration: run.workflowExecutionGeneration,
    retryOfRunId: run.retryOfRunId,
    executionScopeKind: run.executionScopeKind,
    executionEpoch: run.executionEpoch,
    executionToken: run.executionToken,
    executorOwnerId: run.executorOwnerId,
    executorOwnerLeaseEpoch: run.executorOwnerLeaseEpoch,
    executorOwnerLeaseToken: run.executorOwnerLeaseToken,
    executorOwnerLeaseExpiresAt: run.executorOwnerLeaseExpiresAt,
    executorOwnerAcknowledgedAt: run.executorOwnerAcknowledgedAt,
    executorOwnerReleasedAt: run.executorOwnerReleasedAt,
    processLossRetryCount: run.processLossRetryCount,
  });
}

function captureOriginalWakeIdentity(wake: typeof agentWakeupRequests.$inferSelect): QaCorrectionOriginalWakeIdentity {
  return Object.freeze({ id: wake.id, companyId: wake.companyId, agentId: wake.agentId,
    issueId: wake.issueId, missionId: wake.missionId, runId: wake.runId, workflowRunId: wake.workflowRunId,
    workflowStepRunId: wake.workflowStepRunId, workflowExecutionGeneration: wake.workflowExecutionGeneration,
    status: wake.status, claimedAt: wake.claimedAt, finishedAt: wake.finishedAt });
}

function sameExecutionIdentity(run: Run, expected: QaCorrectionExecutionIdentity) {
  try { return same(captureQaCorrectionExecutionIdentity(run), expected); }
  catch { return false; }
}

async function discoverExecutionScope(db: Db, run: Run,
  phase: "claim" | "adapter_start"): Promise<QaCorrectionExecutionScope> {
  const expected = captureQaCorrectionExecutionIdentity(run);
  const [current] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  if (!current || !sameExecutionIdentity(current, expected)
    || (phase === "claim" ? current.status !== "queued" : current.status !== "running")) {
    throw new QaRemediationAdmissionHold("execution_identity_changed", []);
  }

  const context = parseObject(current.contextSnapshot);
  const contextId = (key: string) => {
    if (!Object.hasOwn(context, key) || context[key] == null) return null;
    const value = context[key];
    if (typeof value !== "string" || !value.trim()) throw new QaRemediationAdmissionHold("execution_context_identity_malformed", []);
    return value;
  };
  const contextCount = (key: string) => {
    if (!Object.hasOwn(context, key) || context[key] == null) return null;
    const value = context[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new QaRemediationAdmissionHold("execution_context_identity_malformed", []);
    }
    return value;
  };
  const contextIssueId = contextId("issueId");
  const contextStepRunId = contextId("workflowStepRunId");
  const contextRunId = contextId("workflowRunId");
  const contextMissionId = contextId("missionId");
  const contextGeneration = contextCount("workflowExecutionGeneration");
  const [wake] = expected.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, expected.wakeupRequestId), eq(agentWakeupRequests.companyId, expected.companyId))) : [];
  if (expected.wakeupRequestId && (!wake || wake.agentId !== expected.agentId
    || (wake.runId !== null && wake.runId !== expected.heartbeatRunId))) {
    throw new QaRemediationAdmissionHold("execution_wake_identity_unproven", []);
  }
  if (wake && (phase === "claim" ? wake.status !== "queued"
    : wake.status !== "claimed" || !wake.claimedAt)) {
    throw new QaRemediationAdmissionHold("execution_wake_state_unproven", []);
  }
  if (wake && expected.issueId !== wake.issueId) throw new QaRemediationAdmissionHold("execution_wake_issue_changed", []);
  if (wake && contextMissionId !== null && wake.missionId !== null && wake.missionId !== contextMissionId) {
    throw new QaRemediationAdmissionHold("execution_context_mission_conflict", []);
  }
  const wakeRef = wake ? (() => {
    try { return readQaCorrectionWakeRef(wake); }
    catch (error) { throw new QaRemediationAdmissionHold("execution_wake_correction_ref_unproven", [], error); }
  })() : null;

  let proof: ReturnType<typeof readWorkflowAttemptProof> | null = null;
  if (wake && (wake.workflowRunId || wake.workflowStepRunId || wake.workflowExecutionGeneration !== null)) {
    try { proof = readWorkflowAttemptProof(wake); }
    catch (error) { throw new QaRemediationAdmissionHold("execution_attempt_proof_unproven", [], error); }
  }
  const issueIds = sorted([expected.issueId, contextIssueId, wake?.issueId, proof?.issueId]
    .filter((id): id is string => id !== null && id !== undefined));
  const stepIds = sorted([expected.workflowStepRunId, contextStepRunId, wake?.workflowStepRunId, proof?.stepRunId]
    .filter((id): id is string => id !== null && id !== undefined));
  const directRunIds = sorted([contextRunId, wake?.workflowRunId, proof?.workflowRunId]
    .filter((id): id is string => id !== null && id !== undefined));
  const generations = [expected.workflowExecutionGeneration, contextGeneration,
    wake?.workflowExecutionGeneration ?? null, proof?.executionGeneration].filter((value): value is number => value !== null && value !== undefined);
  if (issueIds.length > 1 || stepIds.length > 1 || directRunIds.length > 1 || new Set(generations).size > 1) {
    throw new QaRemediationAdmissionHold("execution_context_identity_conflict", []);
  }

  const relatedPredicates = [
    ...(issueIds.length ? [inArray(workflowStepRuns.issueId, issueIds)] : []),
    ...(stepIds.length ? [inArray(workflowStepRuns.id, stepIds)] : []),
  ];
  const relatedSteps = relatedPredicates.length ? await db.select({ step: workflowStepRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowRuns.companyId, expected.companyId), or(...relatedPredicates))).then(rows => rows.map(row => row.step)) : [];
  const origins = issueIds.length ? await db.select({ issueId: issues.id, runId: issues.originRunId })
    .from(issues).where(and(eq(issues.companyId, expected.companyId), inArray(issues.id, issueIds),
      eq(issues.originKind, "workflow_execution"))) : [];


  const hasWorkflowHint = Boolean(expected.workflowStepRunId || expected.workflowExecutionGeneration !== null
    || contextStepRunId || contextRunId || contextGeneration !== null || wake?.workflowRunId || wake?.workflowStepRunId
    || wake?.workflowExecutionGeneration !== null && wake?.workflowExecutionGeneration !== undefined || wakeRef);
  if (!proof) {
    const runIds = sorted([...relatedSteps.map(step => step.workflowRunId),
      ...origins.flatMap(origin => origin.runId ? [origin.runId] : [])]);
    const scopedRuns = runIds.length ? await db.select().from(workflowRuns).where(and(
      eq(workflowRuns.companyId, expected.companyId), inArray(sql<string>`${workflowRuns.id}::text`, runIds))) : [];
    let c5Pending = false;
    for (const scopedRun of scopedRuns) c5Pending = await hasPendingQaRemediationForRun(db, scopedRun) || c5Pending;
    const [authority] = scopedRuns.length ? await db.select({ id: workflowRecoveryAuthorities.id })
      .from(workflowRecoveryAuthorities).where(and(eq(workflowRecoveryAuthorities.companyId, expected.companyId),
        or(inArray(workflowRecoveryAuthorities.workflowRunId, scopedRuns.map(row => row.id)),
          inArray(workflowRecoveryAuthorities.replacementRunId, scopedRuns.map(row => row.id))))).limit(1) : [];
    if (hasWorkflowHint || scopedRuns.length !== runIds.length || c5Pending || authority
      || relatedSteps.some(step => step.status === "held" || step.status === "blocked")) {
      throw new QaRemediationAdmissionHold("execution_attempt_scope_unproven", []);
    }
    const missionIds = sorted([contextMissionId, wake?.missionId].filter((id): id is string => !!id));
    if (missionIds.length > 1) throw new QaRemediationAdmissionHold("execution_context_mission_conflict", []);
    return Object.freeze({ kind: "unlinked" as const, primaryWorkflowRunId: null,
      workflowRunIds: Object.freeze([]) as readonly [], workflowRuns: Object.freeze([]) as readonly [],
      missionId: missionIds[0] ?? null,
      originalWake: wake ? captureOriginalWakeIdentity(wake) : null,
      resolvedAttempt: null, replacementAuthorities: Object.freeze([]) as readonly [] });
  }

  if (origins.some(origin => !origin.runId)) throw new QaRemediationAdmissionHold("execution_issue_origin_unproven", []);

  if (!wake || wake.runId !== expected.heartbeatRunId || wake.companyId !== proof.companyId
    || proof.companyId !== expected.companyId || proof.agentId !== expected.agentId
    || proof.wakeupRequestId !== expected.wakeupRequestId || proof.issueId !== expected.issueId
    || (expected.workflowStepRunId !== null && expected.workflowStepRunId !== proof.stepRunId)
    || (expected.workflowExecutionGeneration !== null && expected.workflowExecutionGeneration !== proof.executionGeneration)
    || (contextIssueId !== null && contextIssueId !== proof.issueId)
    || (contextStepRunId !== null && contextStepRunId !== proof.stepRunId)
    || (contextRunId !== null && contextRunId !== proof.workflowRunId)
    || (contextGeneration !== null && contextGeneration !== proof.executionGeneration)
    || (contextMissionId !== null && contextMissionId !== proof.missionId)
    || (wake.missionId !== proof.missionId)) {
    throw new QaRemediationAdmissionHold("execution_attempt_identity_conflict", []);
  }
  const matchingSteps = relatedSteps.filter(step => step.id === proof!.stepRunId);
  if (matchingSteps.length !== 1 || matchingSteps[0]!.workflowRunId !== proof.workflowRunId
    || matchingSteps[0]!.issueId !== proof.issueId || matchingSteps[0]!.executionGeneration !== proof.executionGeneration
    || matchingSteps[0]!.retryCount !== proof.retryCount || matchingSteps[0]!.iterationIndex !== proof.iterationIndex) {
    throw new QaRemediationAdmissionHold("execution_attempt_scope_unproven", []);
  }
  let attempt: { retryCount: number; iterationIndex: number };
  try {
    attempt = await producerAttempt(db, { ...current, workflowStepRunId: proof.stepRunId,
      workflowExecutionGeneration: proof.executionGeneration }, matchingSteps[0]!, new Set(), phase === "claim");
  } catch (error) { throw new QaRemediationAdmissionHold("execution_attempt_producer_unproven", [], error); }
  if (attempt.retryCount !== proof.retryCount || attempt.iterationIndex !== proof.iterationIndex) {
    throw new QaRemediationAdmissionHold("execution_attempt_counters_changed", []);
  }

  const runIds = new Set<string>([proof.workflowRunId, ...relatedSteps.map(step => step.workflowRunId),
    ...origins.map(origin => origin.runId!).filter((id): id is string => !!id)]);
  const replacementAuthorities = new Map<string, QaCorrectionReplacementAuthority>();
  const processed = new Set<string>();
  const addReplacement = async (targetRunId: string, expectedAuthorityId?: string) => {
    const replacement = await discoverQaRemediationWorkflowScope(db, targetRunId);
    const authority = replacement.authority;
    if (!authority || !replacement.source || (expectedAuthorityId && authority.id !== expectedAuthorityId)) {
      throw new QaRemediationAdmissionHold("execution_replacement_authority_unproven", []);
    }
    if (authority.companyId !== expected.companyId || replacement.source.companyId !== expected.companyId
      || replacement.source.id !== authority.workflowRunId || replacement.target.id !== authority.replacementRunId) {
      throw new QaRemediationAdmissionHold("execution_replacement_scope_unproven", []);
    }
    replacementAuthorities.set(replacement.target.id, Object.freeze({ sourceRunId: replacement.source.id,
      targetRunId: replacement.target.id, authority }));
    runIds.add(replacement.source.id);
    runIds.add(replacement.target.id);
  };
  while ([...runIds].some(id => !processed.has(id))) {
    if (processed.size >= 64) throw new QaRemediationAdmissionHold("execution_scope_unbounded", []);
    const id = sorted([...runIds].filter(value => !processed.has(value)))[0]!;
    processed.add(id);
    const [relatedRun] = await db.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, id), eq(workflowRuns.companyId, expected.companyId)));
    if (!relatedRun) throw new QaRemediationAdmissionHold("execution_scope_run_missing", []);
    const discovered = await discoverQaRemediationWorkflowScope(db, id);
    if (discovered.authority) await addReplacement(id, discovered.authority.id);
    const outgoing = await db.select().from(workflowRecoveryAuthorities).where(and(
      eq(workflowRecoveryAuthorities.companyId, expected.companyId),
      eq(workflowRecoveryAuthorities.workflowRunId, id)));
    for (const authority of outgoing) {
      if (authority.recoveryKind === "replacement_from_start_v1" && authority.status === "consumed"
        && authority.replacementRunId) await addReplacement(authority.replacementRunId, authority.id);
    }
  }
  const workflowRunIds = sorted([...runIds]);
  const runRows = await db.select({ id: workflowRuns.id, companyId: workflowRuns.companyId,
    missionId: workflowRuns.missionId, workflowId: workflowRuns.workflowId,
    dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion, status: workflowRuns.status })
    .from(workflowRuns).where(and(eq(workflowRuns.companyId, expected.companyId), inArray(workflowRuns.id, workflowRunIds)));
  if (runRows.length !== workflowRunIds.length
    || runRows.find(row => row.id === proof!.workflowRunId)?.missionId !== proof.missionId) {
    throw new QaRemediationAdmissionHold("execution_scope_run_missing", []);
  }
  const workflowRunsSnapshot = runRows.map(row => Object.freeze(row)).sort((a, b) =>
    (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id));
  const authoritySnapshot = [...replacementAuthorities.values()].sort((a, b) => a.targetRunId.localeCompare(b.targetRunId));
  const resolvedAttempt = Object.freeze({ originalWake: captureOriginalWakeIdentity(wake),
    proof: Object.freeze(proof), retryCount: attempt.retryCount,
    iterationIndex: attempt.iterationIndex, c02FollowupRef: wakeRef as QaCorrectionFollowupRef | null });
  return Object.freeze({ kind: "linked" as const, primaryWorkflowRunId: proof.workflowRunId,
    workflowRunIds: Object.freeze(workflowRunIds), workflowRuns: Object.freeze(workflowRunsSnapshot),
    resolvedAttempt, replacementAuthorities: Object.freeze(authoritySnapshot) });
}

async function lockCurrentExecutionIdentity(db: Db, expected: QaCorrectionExecutionIdentity,
  scope: QaCorrectionExecutionScope, phase: "claim" | "adapter_start"): Promise<boolean> {
  const [current] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, expected.heartbeatRunId), eq(heartbeatRuns.companyId, expected.companyId))).for("update");
  if (!current || !sameExecutionIdentity(current, expected)) {
    throw new QaRemediationAdmissionHold("execution_identity_changed", []);
  }
  const [wake] = expected.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, expected.wakeupRequestId), eq(agentWakeupRequests.companyId, expected.companyId))).for("update") : [];
  const expectedWake = scope.kind === "unlinked" ? scope.originalWake : scope.resolvedAttempt.originalWake;
  if ((expected.wakeupRequestId === null) !== (expectedWake === null)
    || (expected.wakeupRequestId && !wake)
    || (wake && (!expectedWake || !same(captureOriginalWakeIdentity(wake), expectedWake)))) {
    throw new QaRemediationAdmissionHold("execution_wake_identity_changed", []);
  }
  if (scope.kind === "unlinked") {
    if (wake && (wake.workflowRunId || wake.workflowStepRunId || wake.workflowExecutionGeneration !== null)) {
      throw new QaRemediationAdmissionHold("execution_unlinked_wake_changed", []);
    }
  } else {
    if (!wake) throw new QaRemediationAdmissionHold("execution_wake_identity_unproven", []);
    let proof: ReturnType<typeof readWorkflowAttemptProof>;
    try { proof = readWorkflowAttemptProof(wake); }
    catch (error) { throw new QaRemediationAdmissionHold("execution_attempt_proof_changed", [], error); }
    if (!same(proof, scope.resolvedAttempt.proof)
      || (expected.workflowStepRunId !== null && expected.workflowStepRunId !== proof.stepRunId)
      || (expected.workflowExecutionGeneration !== null && expected.workflowExecutionGeneration !== proof.executionGeneration)) {
      throw new QaRemediationAdmissionHold("execution_attempt_changed", []);
    }
  }
  if (phase === "claim") return current.status === "queued" && (!wake || wake.status === "queued");
  if (current.status !== "running" || (wake && (wake.status !== "claimed" || !wake.claimedAt))) {
    throw new QaRemediationAdmissionHold("execution_not_currently_started", []);
  }
  if (current.finalizationVersion === 1 && (!current.executorOwnerAcknowledgedAt || current.executorOwnerReleasedAt
    || !current.executorOwnerLeaseExpiresAt || current.executorOwnerLeaseExpiresAt <= new Date())) {
    throw new QaRemediationAdmissionHold("execution_owner_not_current", []);
  }
  return true;
}

async function lockExecutionRunPrefix(db: Db, scope: QaCorrectionExecutionScope, companyId: string): Promise<void> {
  if (scope.kind === "unlinked") {
    if (scope.missionId) {
      const [mission] = await db.select({ id: missions.id }).from(missions).where(and(
        eq(missions.id, scope.missionId), eq(missions.companyId, companyId))).for("no key update");
      if (!mission) throw new QaRemediationAdmissionHold("execution_mission_scope_changed", []);
    }
    return;
  }
  const orderedRuns = [...scope.workflowRuns].sort((a, b) =>
    (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id));
  for (const missionId of sorted(orderedRuns.flatMap(run => run.missionId ? [run.missionId] : []))) {
    const expected = orderedRuns.find(run => run.missionId === missionId)!;
    const [mission] = await db.select({ id: missions.id, companyId: missions.companyId }).from(missions)
      .where(and(eq(missions.id, missionId), eq(missions.companyId, expected.companyId))).for("no key update");
    if (!mission) throw new QaRemediationAdmissionHold("execution_mission_scope_changed", []);
  }
  const lockedRuns: typeof orderedRuns = [];
  for (const expected of orderedRuns) {
    const [locked] = await db.select({ id: workflowRuns.id, companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId, workflowId: workflowRuns.workflowId,
      dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion, status: workflowRuns.status })
      .from(workflowRuns).where(eq(workflowRuns.id, expected.id)).for("no key update");
    if (!locked || !same(locked, expected)) throw new QaRemediationAdmissionHold("execution_run_prefix_changed", []);
    lockedRuns.push(locked);
  }
  if (!same(lockedRuns, orderedRuns)) throw new QaRemediationAdmissionHold("execution_run_prefix_changed", []);
  if (scope.replacementAuthorities.length) {
    const authorityIds = scope.replacementAuthorities.map(item => item.authority.id).sort();
    const lockedAuthorities = await db.select().from(workflowRecoveryAuthorities)
      .where(inArray(workflowRecoveryAuthorities.id, authorityIds)).orderBy(asc(workflowRecoveryAuthorities.id)).for("share");
    const expectedAuthorities = [...scope.replacementAuthorities].map(item => item.authority)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!same(lockedAuthorities, expectedAuthorities)) {
      throw new QaRemediationAdmissionHold("execution_replacement_authority_changed", []);
    }
  }
}

/** Discovery follows only the actual original wakes. A reserved malformed ref never becomes ordinary. */
async function lineage(db: Connection, run: Run) {
  const chain: Run[] = [], wakes: DeliveryWake[] = [], seen = new Set<string>();
  let id: string | null = run.id;
  let missingWake = false;
  while (id) {
    if (seen.has(id) || seen.size >= 32) throw conflict("heartbeat_workflow_attempt_unproven");
    seen.add(id);
    const [current]: Run[] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    requireClaim(current && current.companyId === run.companyId);
    chain.push(current!);
    if (!current!.wakeupRequestId) missingWake = true;
    else {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, current!.wakeupRequestId!));
      requireClaim(wake);
      wakes.push(wake!);
      let ref: ReturnType<typeof readQaCorrectionWakeRef>;
      try { ref = readQaCorrectionWakeRef(wake!); }
      catch (error) { throw new QaCorrectionClaimRejected(error); }
      if (ref) return { chain, wakes, ref, missingWake };
    }
    id = current!.retryOfRunId;
  }
  return { chain, wakes, ref: null, missingWake };
}
type Lineage = Awaited<ReturnType<typeof lineage>>;

/** Historical counters come from issuance; mutable display counters cannot restamp the original proof. */
async function prove(db: Connection, run: Run, l: Lineage, pause: PauseDeliveryObservation | null) {
  requireClaim(l.ref && !l.missingWake && same(identity(l.chain[0]!), identity(run)));
  const h = await readIssuedQaCorrectionFollowupForAttempt(db, l.ref!), target = h.followup.target;
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, target.stepRunId));
  requireClaim(step && step.workflowRunId === l.ref!.workflowRunId && step.issueId === target.issueId
    && step.stepId === target.stepId);
  const first = l.chain[0]!, wake = l.wakes[0]!;
  requireClaim((first.workflowStepRunId === null || first.workflowStepRunId === wake.workflowStepRunId)
    && (first.workflowExecutionGeneration === null || first.workflowExecutionGeneration === wake.workflowExecutionGeneration));
  const frozen = { ...step!, executionGeneration: target.executionGeneration, retryCount: target.retryCount,
    iterationIndex: target.iterationIndex };
  if (pause) await provePauseDeliveryAttempt(db, pause, first, frozen);
  else await producerAttempt(db, { ...first, workflowStepRunId: wake.workflowStepRunId,
    workflowExecutionGeneration: wake.workflowExecutionGeneration }, frozen, new Set(), first.status === "queued");
  return h;
}
/** Correction history has no technical-retry limit. Collect every historical proof's lock dependencies. */
async function scope(db: Db, h: DeliveryHistory) {
  const readIssued = createQaCorrectionHistorySession(db, h.ref);
  const history = new Map<string, IssuedQaCorrection>([[h.issued.preparation.correctionId, h.issued]]);
  for (const issued of history.values()) {
    for (const source of issued.preparation.sources) {
      if (source.provenance.kind !== "prior_correction") continue;
      const prior = await readIssued(db, { companyId: h.ref.companyId,
        workflowRunId: h.ref.workflowRunId, appliedEventId: source.provenance.appliedEventId });
      requireClaim(prior.preparation.missionId === h.issued.preparation.missionId);
      history.set(prior.preparation.correctionId, prior);
    }
  }
  const all = [...history.values()], preparations = all.map(s => s.preparation);
  return {
    targets: [h.followup.target, ...preparations.flatMap(p => [p.producer,
      ...p.authority.verdicts.map(v => v.qa), ...p.bindings.map(b => b.consumer)])],
    products: sorted(all.flatMap(s => [...s.preparation.sources.map(p => p.productId),
      ...s.applied.revisions.map(r => r.workProductId)])),
    bindings: sorted(preparations.flatMap(p => p.bindings.map(b => b.bindingId))),
    heartbeatIds: sorted(preparations.flatMap(p => [
      ...p.authority.verdicts.map(v => v.heartbeatRunId),
      ...p.sources.flatMap(s => s.provenance.kind === "workflow_producer" ? [s.provenance.workflowProducer.heartbeatRunId] : []),
      ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : []),
    ])),
  };
}
type Dependencies = Awaited<ReturnType<typeof scope>>;

async function issueRows(db: Connection, h: DeliveryHistory, s: Dependencies) {
  return db.select().from(issues).where(and(eq(issues.companyId, h.ref.companyId),
    inArray(issues.id, sorted(s.targets.map(t => t.issueId))))).orderBy(asc(issues.id));
}
async function heartbeats(db: Connection, h: DeliveryHistory, l: Lineage,
  rows: Awaited<ReturnType<typeof issueRows>>, s: Dependencies) {
  const ids = [...s.heartbeatIds, ...l.chain.map(r => r.id),
    ...rows.flatMap(r => [r.executionRunId, r.checkoutRunId])].filter((id): id is string => !!id);
  const found = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, h.ref.companyId),
    or(inArray(heartbeatRuns.issueId, rows.map(r => r.id)), inArray(heartbeatRuns.id, ids))));
  const all = new Map(found.map(r => [r.id, r]));
  requireClaim(ids.every(id => all.has(id)));
  // Include technical parents before locking anything. Set membership terminates corrupt cycles.
  for (const row of all.values()) {
    if (!row.retryOfRunId || all.has(row.retryOfRunId)) continue;
    const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.retryOfRunId));
    requireClaim(parent && parent.companyId === h.ref.companyId);
    all.set(parent!.id, parent!);
  }
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function observe(db: Db, run: Run, l: Lineage) {
  const h = await readQaCorrectionFollowupDb(db, l.ref!, createQaCorrectionHistorySession(db, l.ref!));
  const token = await observeQaCorrectionFollowup(db, l.ref!, createQaCorrectionHistorySession(db, l.ref!));
  const dependencies = await scope(db, h), rows = await issueRows(db, h, dependencies);
  const observed = await heartbeats(db, h, l, rows, dependencies);
  requireClaim(observed.some(r => r.id === run.id));
  return { h, token, rows, observed, dependencies };
}
type Observation = Awaited<ReturnType<typeof observe>>;

async function lock(tx: DeliveryTx, run: Run, l: Lineage, o: Observation,
  admit: (db: Db) => Promise<void>) {
  const p = o.h.issued.preparation;
  if (p.authority.kind === "quality_current_output") {
    await lockQualityAttemptBudget(tx, { companyId: run.companyId, actionId: p.authority.actionId, now: new Date() });
  }
  // Existing admission locks every mission/run identity (including the original wake) before any heartbeat.
  await admit(tx as unknown as Db);
  await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    inArray(heartbeatRuns.id, o.observed.map(r => r.id)))).orderBy(asc(heartbeatRuns.id)).for("update");
  const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  requireClaim(current);
  if (run.status === "queued" && current!.status !== "queued") return false;
  await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId),
    inArray(issues.id, o.rows.map(r => r.id)))).orderBy(asc(issues.id)).for("update");
  const rows = await issueRows(tx, o.h, o.dependencies), observed = await heartbeats(tx, o.h, l, rows, o.dependencies);
  requireClaim(same(rows.map(owner), o.rows.map(owner))
    && same(observed.map(identity), o.observed.map(identity)));
  await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, p.workflowRunId),
    inArray(workflowStepRuns.id, sorted(o.dependencies.targets.map(t => t.stepRunId)))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, run.companyId),
    inArray(issueWorkProducts.id, o.dependencies.products))).orderBy(asc(issueWorkProducts.id)).for("update");
  await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, run.companyId),
    eq(workflowStepOutputBindings.workflowRunId, p.workflowRunId),
    inArray(workflowStepOutputBindings.id, o.dependencies.bindings)))
    .orderBy(asc(workflowStepOutputBindings.id)).for("update");
  const wakeIds = sorted([...l.wakes.map(w => w.id),
    ...o.observed.flatMap(r => r.wakeupRequestId ? [r.wakeupRequestId] : [])]);
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds))
    .orderBy(asc(agentWakeupRequests.id)).for("update");
  return true;
}

async function currentPermission(tx: DeliveryTx, run: Run, o: Observation) {
  const h = await readCurrentQaCorrectionFollowup(tx, o.h.ref, o.token, createQaCorrectionHistorySession(tx, o.h.ref));
  const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)));
  const issue = h.database.target.issue, verdict = h.issued.preparation.authority.verdicts.find(v => same(v.qa, h.followup.target));
  const origin = o.observed.find(r => r.id === verdict?.heartbeatRunId);
  requireClaim(agent && (issue.assigneeAgentId ? issue.assigneeAgentId === run.agentId : origin?.agentId === run.agentId)
    && !issue.hiddenAt && issue.status !== "cancelled" && (issue.status !== "done" || h.followup.operation === "recheck"));
  const policy = parseObject(parseObject(agent!.runtimeConfig).heartbeat);
  requireClaim(run.invocationSource === "timer" ? asBoolean(policy.enabled, true)
    : asBoolean(policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation, true));
}

/** No files or root impersonation in a savepoint. Real roots observe afresh at BOTH execution boundaries. */
export async function withQaCorrectionClaimRoot<T>(db: Db, run: Run,
  admit: (db: Db) => Promise<void>, write: (db: Db) => Promise<T>): Promise<Boundary<T>> {
  return claimRoot(db, run, null, admit, write);
}
/** Same history, bytes, quality prefix and owner checks, with a persisted stopped-original proof. */
export async function withPausedQaCorrectionDeliveryRoot<T>(db: Db, observation: PauseDeliveryObservation,
  admit: (db: Db) => Promise<void>, write: (db: Db) => Promise<T>): Promise<Boundary<T>> {
  return claimRoot(db, pauseDeliveryRun(observation), observation, admit, write);
}

export type ExecutionBoundary<T> = QaCorrectionExecutionBoundary<T>;

/** The opt-in execution path keeps native acquisition outside DB locks and reuses the C02 lock prefix. */
export async function withQaCorrectionExecutionRoot<T>(db: Db, run: Run,
  input: QaCorrectionExecutionRootInput<T>): Promise<ExecutionBoundary<T>> {
  let l: Lineage;
  let observation: Observation | null = null;
  try {
    l = await lineage(db, run);
    if (l.ref) await prove(db, run, l, null);
    else if (input.phase === "claim") await readAdmittedWorkflowIdentity(db, run);
    if (is(db, PgTransaction)) {
      registerQaCorrectionRootDrain(db, run.agentId);
      return { kind: "root_deferred" };
    }
    if (l.ref) observation = await observe(db, run, l);
  } catch (error) {
    if (isQaCorrectionRootOwnerRequired(error)) throw error;
    if (error instanceof QaRemediationAdmissionHold) throw error;
    throw error instanceof QaCorrectionClaimRejected ? error : new QaCorrectionClaimRejected(error);
  }
  const identity = captureQaCorrectionExecutionIdentity(run);
  let initialScope: QaCorrectionExecutionScope;
  try { initialScope = await discoverExecutionScope(db, run, input.phase); }
  catch (error) {
    if (input.phase === "claim" && run.status === "queued" && !is(db, PgTransaction)
      && error instanceof QaRemediationAdmissionHold) discoveryHolds.set(error, { db, identity });
    throw error;
  }
  if (l.ref && initialScope.kind === "unlinked") {
    throw new QaRemediationAdmissionHold("execution_correction_lineage_scope_unproven", []);
  }
  const strategy = {
    phase: input.phase,
    identity,
    discoverScope: (connection: Db) => discoverExecutionScope(connection, run, input.phase),
    admit: async (connection: Db, scope: QaCorrectionExecutionScope,
      context: QaRemediationAdmissionContext): Promise<boolean> => {
      if (l.ref && observation) {
        try {
          const current = await lineage(connection, run);
          requireClaim(same(current, l));
          if (!await lock(connection as unknown as DeliveryTx, run, l, observation,
            async tx => {
              await lockExecutionRunPrefix(tx, scope, identity.companyId);
              await input.admit(tx, run, scope, context);
            })) return false;
          const fresh = await lineage(connection, run);
          requireClaim(same(fresh, l));
          await prove(connection, run, fresh, null);
          await currentPermission(connection as unknown as DeliveryTx, run, observation);
        } catch (error) {
          if (isQaCorrectionRootOwnerRequired(error)) throw error;
          if (error instanceof QaRemediationAdmissionHold) throw error;
          throw error instanceof QaCorrectionClaimRejected ? error : new QaCorrectionClaimRejected(error);
        }
      } else {
        await lockExecutionRunPrefix(connection, scope, identity.companyId);
        const admissionRun = scope.kind === "unlinked" && scope.missionId
          ? { ...run, missionId: scope.missionId } as Run : run;
        await input.admit(connection, admissionRun, scope, context);
      }
      return lockCurrentExecutionIdentity(connection, identity, scope, input.phase);
    },
    validateInvocation: async (connection: Db, scope: QaCorrectionExecutionScope,
      _context: QaRemediationAdmissionContext): Promise<void> => {
      const freshScope = await discoverExecutionScope(connection, run, "adapter_start");
      if (!same(freshScope, scope)) throw new QaRemediationAdmissionHold("execution_scope_changed", []);
      if (l.ref) {
        try {
          const fresh = await lineage(connection, run);
          requireClaim(same(fresh, l));
          await prove(connection, run, fresh, null);
        } catch (error) {
          if (isQaCorrectionRootOwnerRequired(error)) throw error;
          if (error instanceof QaRemediationAdmissionHold) throw error;
          throw error instanceof QaCorrectionClaimRejected ? error : new QaCorrectionClaimRejected(error);
        }
      }
      if (!await lockCurrentExecutionIdentity(connection, identity, scope, "adapter_start")) {
        throw new QaRemediationAdmissionHold("execution_not_currently_started", []);
      }
    },
    work: (connection: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext,
      invokeOnce: QaCorrectionExecutionInvokeOnce) => input.work(connection, run, scope, context, invokeOnce),
  };
  return withQaRemediationSharedAdmission({
    ...input.sharedAdmission,
    db,
    runId: initialScope.primaryWorkflowRunId,
    execution: strategy,
  });
}

async function claimRoot<T>(db: Db, run: Run, pause: PauseDeliveryObservation | null,
  admit: (db: Db) => Promise<void>, write: (db: Db) => Promise<T>): Promise<Boundary<T>> {
  const l = await lineage(db, run);
  if (!l.ref) {
    return db.transaction(async tx => {
      const t = tx as unknown as Db;
      await admit(t);
      return { kind: "performed" as const, value: await write(t) };
    });
  }
  try {
    await prove(db, run, l, pause);
    if (is(db, PgTransaction)) {
      registerQaCorrectionRootDrain(db, run.agentId);
      return { kind: "root_deferred" };
    }
    const o = await observe(db, run, l);
    return await db.transaction(async tx => {
      if (!await lock(tx, run, l, o, admit)) return { kind: "not_claimed" as const };
      const fresh = await lineage(tx, run);
      requireClaim(same(fresh, l));
      await prove(tx, run, fresh, pause);
      await currentPermission(tx, run, o);
      return { kind: "performed" as const, value: await write(tx as unknown as Db) };
    });
  } catch (error) {
    if (isQaCorrectionRootOwnerRequired(error)) throw error;
    throw error instanceof QaCorrectionClaimRejected ? error : new QaCorrectionClaimRejected(error);
  }
}
