import { and, asc, eq, inArray, is, or, isNotNull } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { isDeepStrictEqual } from "node:util";
import { agentWakeupRequests, heartbeatRuns, missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { replacementApprovalPayloadSchema, type ReplacementApprovalPayload }
  from "@paperclipai/shared/validators/workflow-replacement";
import { readQaRemediationActualDrain } from "../../heartbeat-actual-drain.js";
import { createReplacementRootNotifications, registerQaCorrectionRootDrain, withReplacementRootNotificationDb,
  type ReplacementRootNotifications } from "../../issue-assignment-wakeup.js";
import { QA_REMEDIATION_EVENT_TYPE } from "./qa-remediation-contract.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, classifyQaRemediationLegacyRow, parseQaRemediationPreparation,
  qaRemediationPreparationKey, type QaRemediationPreparation, type QaRemediationPreparationScope,
  type QaRemediationVerdict } from "./qa-remediation-preparation-contract.js";
import { qaRemediationCompletionKey, validateQaRemediationCompletionEvidence } from "./qa-remediation-completion-evidence.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "./qa-remediation-completion.js";
import { readQaCorrectionVerdict } from "./qa-correction-authority.js";
import { computeDefectSignature } from "./knowledge-draft-capture.js";
import { type QaCorrectionVerdictAuthority } from "./qa-correction-contract.js";
import { readIssuedQaCorrection, type IssuedQaCorrection } from "./qa-correction-reader.js";
import { hashStructuredValue } from "../../issue-execution-cards/hash.js";
import type { QaFileOwnerRuntime } from "./qa-remediation-runtime.js";
import type { QaRemediationFileOwner, FileOwnerExit } from "./qa-remediation-file-owner.js";
import type { ChildStartIdentity, LockedChildStartContext } from "../workflow-child-start-state.js";

const replacementSourcePreservationBrand: unique symbol = Symbol("consumed_replacement_source");
type ReplacementSourcePreservation = Readonly<{
  readonly kind: "consumed_replacement_source";
  readonly [replacementSourcePreservationBrand]: true;
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly authorityId: string;
  readonly sourceAuthorityVersion: number;
  readonly targetAuthorityVersion: number;
  readonly sourceEventIds: readonly string[];
}>;
export type QaRemediationAdmissionContext = Readonly<{
  pending: readonly { readonly eventId: string; readonly preparation: QaRemediationPreparation }[];
  replacementSourcePreservation?: ReplacementSourcePreservation;
}>;

const c5NotInvokedProofBrand: unique symbol = Symbol("c5_held_not_invoked");
export type C5NotInvokedProof = Readonly<{
  readonly kind: "c5_held_not_invoked";
  readonly [c5NotInvokedProofBrand]: true;
}>;
export type QaCorrectionExecutionIdentity = Readonly<{
  readonly heartbeatRunId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string | null;
  readonly wakeupRequestId: string | null;
  readonly workflowStepRunId: string | null;
  readonly workflowExecutionGeneration: number | null;
  readonly retryOfRunId: string | null;
  readonly executionScopeKind: string | null;
  readonly executionEpoch: number | null;
  readonly executionToken: string | null;
  readonly executorOwnerId: string | null;
  readonly executorOwnerLeaseEpoch: number | null;
  readonly executorOwnerLeaseToken: string | null;
  readonly executorOwnerLeaseExpiresAt: Date | null;
  readonly executorOwnerAcknowledgedAt: Date | null;
  readonly executorOwnerReleasedAt: Date | null;
  readonly processLossRetryCount: number | null;
}>;
export type QaCorrectionOriginalWakeIdentity = Readonly<Pick<typeof agentWakeupRequests.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "missionId" | "runId" | "workflowRunId"
  | "workflowStepRunId" | "workflowExecutionGeneration" | "status" | "claimedAt" | "finishedAt">>;
export type QaCorrectionResolvedAttempt = Readonly<{
  readonly originalWake: QaCorrectionOriginalWakeIdentity;
  readonly proof: Readonly<{
    readonly schemaVersion: 1;
    readonly companyId: string;
    readonly agentId: string;
    readonly issueId: string | null;
    readonly missionId: string | null;
    readonly workflowRunId: string;
    readonly stepRunId: string;
    readonly executionGeneration: number;
    readonly retryCount: number;
    readonly iterationIndex: number;
    readonly wakeupRequestId: string;
    readonly parentHeartbeatRunId: string | null;
  }>;
  readonly retryCount: number;
  readonly iterationIndex: number;
  readonly c02FollowupRef: Readonly<Record<string, unknown>> | null;
}>;
export type QaCorrectionReplacementAuthority = Readonly<{
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly authority: typeof workflowRecoveryAuthorities.$inferSelect;
}>;
export type QaCorrectionWorkflowRunIdentity = Readonly<Pick<typeof workflowRuns.$inferSelect,
  "id" | "companyId" | "missionId" | "workflowId" | "dispatchAuthorityVersion" | "status">>;
export type QaCorrectionExecutionScope =
  | Readonly<{
      readonly kind: "unlinked";
      readonly primaryWorkflowRunId: null;
      readonly workflowRunIds: readonly [];
      readonly workflowRuns: readonly [];
      readonly missionId: string | null;
      readonly originalWake: QaCorrectionOriginalWakeIdentity | null;
      readonly resolvedAttempt: null;
      readonly replacementAuthorities: readonly [];
    }>
  | Readonly<{
      readonly kind: "linked";
      readonly primaryWorkflowRunId: string;
      readonly workflowRunIds: readonly string[];
      readonly workflowRuns: readonly QaCorrectionWorkflowRunIdentity[];
      readonly resolvedAttempt: QaCorrectionResolvedAttempt;
      readonly replacementAuthorities: readonly QaCorrectionReplacementAuthority[];
    }>;
export type QaCorrectionExecutionInvokeOnce = <T>(execute: () => Promise<T>) =>
  Promise<Readonly<{ result: Promise<T> }>>;
export type QaCorrectionExecutionBoundary<T> =
  | { readonly kind: "performed"; readonly value: T }
  | { readonly kind: "root_deferred" }
  | { readonly kind: "not_claimed" }
  | { readonly kind: "c5_held_not_invoked"; readonly proof: C5NotInvokedProof };

export type C5NotInvokedProofBinding = Readonly<{
  readonly db: Db;
  readonly identity: QaCorrectionExecutionIdentity;
  readonly phase: "claim" | "adapter_start";
  readonly scope: QaCorrectionExecutionScope;
  readonly scopeVersion: string;
  readonly nativeOwner: QaRemediationFileOwner;
}>;
const c5NotInvokedProofs = new WeakMap<object, C5NotInvokedProofBinding>();

export function isC5NotInvokedProof(value: unknown): value is C5NotInvokedProof {
  return !!value && typeof value === "object" && c5NotInvokedProofs.has(value);
}

/** Read a private C5 binding only for the exact DB, original heartbeat identity, and phase. */
export function readC5NotInvokedProof(value: unknown, expectedDb: Db,
  expectedIdentity: QaCorrectionExecutionIdentity, expectedPhase: "claim" | "adapter_start"): C5NotInvokedProofBinding {
  const binding = value && typeof value === "object" ? c5NotInvokedProofs.get(value) : undefined;
  if (!binding || binding.db !== expectedDb || binding.phase !== expectedPhase
    || !isDeepStrictEqual(binding.identity, expectedIdentity)) {
    throw hold("c5_not_invoked_proof_binding_unproven", []);
  }
  return binding;
}

function mintC5NotInvokedProof(binding: C5NotInvokedProofBinding): C5NotInvokedProof {
  const proof = Object.freeze({ kind: "c5_held_not_invoked" as const, [c5NotInvokedProofBrand]: true as const });
  c5NotInvokedProofs.set(proof, Object.freeze({ ...binding }));
  return proof;
}

export type QaCorrectionExecutionStrategy<T> = Readonly<{
  readonly phase: "claim" | "adapter_start";
  readonly identity: QaCorrectionExecutionIdentity;
  /** Return the exact frozen heartbeat/wake/attempt OR-scope union; malformed linkage must throw. */
  readonly discoverScope: (db: Db) => Promise<QaCorrectionExecutionScope>;
  /** Owns the complete Quality-first, mission/run NO KEY UPDATE, and C02 lock/currentness prefix. */
  readonly admit: (db: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext) => Promise<boolean>;
  readonly validateInvocation: (db: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext) => Promise<void>;
  readonly work: (db: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext,
    invokeOnce: QaCorrectionExecutionInvokeOnce) => Promise<T>;
}>;

type Run = typeof workflowRuns.$inferSelect;
type Authority = typeof workflowRecoveryAuthorities.$inferSelect;
type ReplacementSourcePreservationBinding = Readonly<{
  readonly db: Db;
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly authorityId: string;
  readonly sourceAuthorityVersion: number;
  readonly targetAuthorityVersion: number;
  readonly sourceEventIds: readonly string[];
  readonly targetMarker: string;
  readonly authority: Authority;
  readonly contract: ReplacementApprovalPayload;
}>;
const replacementSourcePreservationBindings = new WeakMap<object, ReplacementSourcePreservationBinding>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Inventory = {
  signature: string;
  pending: QaRemediationAdmissionContext["pending"];
  targets: string[];
  allTargets: string[];
  hasHistory: boolean;
};

type C02IssuedProof = {
  readonly applicationEventId: string;
  readonly issued: IssuedQaCorrection;
  readonly scope: QaRemediationPreparationScope;
  readonly verdicts: readonly {
    readonly authority: QaCorrectionVerdictAuthority;
    readonly items: QaRemediationVerdict["items"];
  }[];
};

export type RootScope = { readonly target: Run; readonly source: Run | null; readonly authority: Authority | null };
type CloseResult = { readonly clean: boolean; readonly exit: FileOwnerExit | null; readonly error?: unknown };
type ChildCancellationAdmission = {
  readonly identity: ChildStartIdentity;
  readonly discoverChild: (db: Db, runId: string) => Promise<{ readonly identity: ChildStartIdentity } | null>;
  readonly setChildLockTimeouts: (db: Db) => Promise<void>;
  readonly lockChildIdentity: (db: Db, identity: ChildStartIdentity) => Promise<LockedChildStartContext | null>;
};

function freezePreparation(value: QaRemediationPreparation): QaRemediationPreparation {
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(value);
  return Object.freeze(value);
}

export class QaRemediationAdmissionHold extends Error {
  constructor(
    readonly reason: string,
    readonly eventIds: readonly string[],
    readonly primaryFailure?: unknown,
    readonly cleanupFailure?: unknown,
  ) {
    super(`qa_remediation_admission_${reason}`);
    this.name = "QaRemediationAdmissionHold";
  }
}

// Only the owning root can attest rollback, clean owner close, and no adapter invocation.
const preInvocationRollbacks = new WeakMap<object, { db: Db; identity: QaCorrectionExecutionIdentity; phase: "claim" | "adapter_start" }>();
export function isC5PreInvocationRollback(error: unknown, db: Db, identity: QaCorrectionExecutionIdentity, phase: "claim" | "adapter_start"): boolean {
  const proof = error && typeof error === "object" ? preInvocationRollbacks.get(error) : undefined;
  return proof?.db === db && proof.phase === phase && isDeepStrictEqual(proof.identity, identity);
}

class InventoryDrift extends Error {}
class UnknownTransactionOutcome extends Error {
  constructor(readonly primary: unknown, readonly transactionFailure?: unknown) {
    super("qa_remediation_admission_transaction_outcome_unknown");
  }
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const cleanExit = (exit: FileOwnerExit | null) => exit !== null && exit.code === 0 && exit.signal === null;
const idsOf = (pending: QaRemediationAdmissionContext["pending"]) => pending.map(item => item.eventId);
const hold = (reason: string, ids: readonly string[], primary?: unknown, cleanup?: unknown) =>
  new QaRemediationAdmissionHold(reason, ids, primary, cleanup);

function hasReplacementAuthorityMarker(run: Run): boolean {
  const metadata = run.metadata;
  return !!metadata && typeof metadata === "object"
    && Object.prototype.hasOwnProperty.call(metadata, "replacementAuthorityId");
}

function replacementAuthorityMarker(run: Run): unknown {
  return run.metadata && typeof run.metadata === "object"
    ? (run.metadata as Record<string, unknown>).replacementAuthorityId : undefined;
}

function inspectReplacementSourcePreservation(db: Db, scope: RootScope | null,
  pending: QaRemediationAdmissionContext["pending"], targetRunId: string): ReplacementSourcePreservationBinding | null {
  if (!scope || scope.target.id !== targetRunId) throw hold("replacement_preservation_target_unproven", idsOf(pending));
  const { target, source, authority } = scope;
  const markerPresent = hasReplacementAuthorityMarker(target);
  if (!authority) {
    if (source || markerPresent) throw hold("replacement_authority_missing", idsOf(pending));
    return null;
  }
  if (!source || !markerPresent || replacementAuthorityMarker(target) !== authority.id
    || authority.recoveryKind !== "replacement_from_start_v1" || authority.status !== "consumed"
    || authority.companyId !== target.companyId || authority.workflowRunId !== source.id
    || authority.replacementRunId !== target.id || source.id === target.id
    || !target.missionId || target.missionId !== source.missionId
    || target.workflowId !== source.workflowId
    || !Number.isSafeInteger(source.dispatchAuthorityVersion) || source.dispatchAuthorityVersion < 0
    || authority.targetAuthorityVersion !== source.dispatchAuthorityVersion
    || authority.resultingAuthorityVersion !== source.dispatchAuthorityVersion
    || !Number.isSafeInteger(target.dispatchAuthorityVersion) || target.dispatchAuthorityVersion < 0
    || !uuidPattern.test(authority.id) || !uuidPattern.test(authority.targetDecisionId ?? "")
    || !uuidPattern.test(authority.ownerDecisionEventId ?? "") || !uuidPattern.test(authority.operatorApprovalId ?? "")
    || typeof authority.requestReference !== "string" || authority.requestReference.length < 1
    || authority.requestReference.length > 200 || !/^[a-f0-9]{64}$/.test(authority.requestHash ?? "")
    || !(authority.consumedAt instanceof Date) || !Number.isFinite(authority.consumedAt.getTime())) {
    throw hold("replacement_authority_binding", idsOf(pending));
  }

  const rawContract = authority.replacementContract;
  if (!rawContract || typeof rawContract !== "object" || Array.isArray(rawContract)) {
    throw hold("replacement_authority_contract_invalid", idsOf(pending));
  }
  const contractResult = replacementApprovalPayloadSchema.safeParse(Object.fromEntries(
    Object.entries(rawContract as Record<string, unknown>).filter(([key]) => key !== "approver")));
  if (!contractResult.success) throw hold("replacement_authority_contract_invalid", idsOf(pending), contractResult.error);
  const contract = contractResult.data;
  const expectedRequestHash = hashStructuredValue({
    intent: {
      schemaVersion: 1,
      sourceRunId: authority.workflowRunId,
      expectedSourceAuthorityVersion: authority.targetAuthorityVersion,
      decisionEventId: authority.ownerDecisionEventId,
      approvalId: authority.operatorApprovalId,
      idempotencyKey: authority.requestReference,
    },
    companyId: target.companyId,
    missionId: target.missionId,
    workflowId: target.workflowId,
    metadata: contract.metadata,
    requester: contract.requesterAgentId,
  });
  if (contract.companyId !== authority.companyId || contract.companyId !== target.companyId
    || contract.missionId !== target.missionId || contract.workflowId !== target.workflowId
    || contract.sourceRunId !== source.id || contract.sourceAuthorityVersion !== source.dispatchAuthorityVersion
    || contract.targetRunId !== target.id || contract.terminalDecisionId !== authority.targetDecisionId
    || contract.decisionEventId !== authority.ownerDecisionEventId || contract.requesterAgentId !== authority.requestedBy
    || contract.idempotencyKey !== authority.requestReference || authority.requestHash !== expectedRequestHash) {
    throw hold("replacement_authority_contract_binding", idsOf(pending));
  }

  const sourceItems = pending.filter(item => item.preparation.workflowRunId === source.id);
  const targetItems = pending.filter(item => item.preparation.workflowRunId === target.id);
  if (sourceItems.some(item => item.preparation.companyId !== source.companyId
      || item.preparation.missionId !== source.missionId || item.preparation.workflowRunId !== source.id)
    || targetItems.some(item => item.preparation.companyId !== target.companyId
      || item.preparation.missionId !== target.missionId || item.preparation.workflowRunId !== target.id)) {
    throw hold("replacement_preservation_inventory_scope", [...idsOf(sourceItems), ...idsOf(targetItems)]);
  }
  const sourceEventIds = sorted(sourceItems.map(item => item.eventId));
  if (new Set(sourceEventIds).size !== sourceItems.length) {
    throw hold("replacement_preservation_inventory_conflict", sourceEventIds);
  }
  const sourcePaths = new Set(sourceItems.flatMap(item => item.preparation.files.map(file => file.path)));
  const overlappingTargetItems = targetItems.filter(item => item.preparation.files.some(file => sourcePaths.has(file.path)));
  if (overlappingTargetItems.length) {
    throw hold("replacement_preparation_path_overlap", [...sourceEventIds, ...idsOf(overlappingTargetItems)]);
  }
  if (!sourceEventIds.length) return null;

  return Object.freeze({
    db,
    companyId: target.companyId,
    missionId: target.missionId,
    workflowId: target.workflowId,
    sourceRunId: source.id,
    targetRunId: target.id,
    authorityId: authority.id,
    sourceAuthorityVersion: source.dispatchAuthorityVersion,
    targetAuthorityVersion: target.dispatchAuthorityVersion,
    sourceEventIds: Object.freeze(sourceEventIds),
    targetMarker: authority.id,
    authority,
    contract: deepFreeze(contract),
  });
}

function mintReplacementSourcePreservation(binding: ReplacementSourcePreservationBinding): ReplacementSourcePreservation {
  const token = Object.freeze({
    kind: "consumed_replacement_source" as const,
    [replacementSourcePreservationBrand]: true as const,
    companyId: binding.companyId,
    missionId: binding.missionId,
    workflowId: binding.workflowId,
    sourceRunId: binding.sourceRunId,
    targetRunId: binding.targetRunId,
    authorityId: binding.authorityId,
    sourceAuthorityVersion: binding.sourceAuthorityVersion,
    targetAuthorityVersion: binding.targetAuthorityVersion,
    sourceEventIds: Object.freeze([...binding.sourceEventIds]),
  });
  replacementSourcePreservationBindings.set(token, binding);
  return token;
}

function admissionContext(db: Db, scope: RootScope | null, pending: QaRemediationAdmissionContext["pending"],
  targetRunId: string): QaRemediationAdmissionContext {
  const binding = inspectReplacementSourcePreservation(db, scope, pending, targetRunId);
  if (!binding) return Object.freeze({ pending });
  return Object.freeze({ pending, replacementSourcePreservation: mintReplacementSourcePreservation(binding) });
}

function sameReplacementSourcePreservationBinding(a: ReplacementSourcePreservationBinding,
  b: ReplacementSourcePreservationBinding): boolean {
  return a.db === b.db && a.companyId === b.companyId && a.missionId === b.missionId && a.workflowId === b.workflowId
    && a.sourceRunId === b.sourceRunId && a.targetRunId === b.targetRunId && a.authorityId === b.authorityId
    && a.sourceAuthorityVersion === b.sourceAuthorityVersion && a.targetAuthorityVersion === b.targetAuthorityVersion
    && isDeepStrictEqual(a.sourceEventIds, b.sourceEventIds) && a.targetMarker === b.targetMarker
    && isDeepStrictEqual(a.authority, b.authority) && isDeepStrictEqual(a.contract, b.contract);
}

function blockingPending(context: QaRemediationAdmissionContext, db: Db, executionRunId: string | null) {
  const token = context.replacementSourcePreservation;
  if (!token) return context.pending;
  const binding = token && typeof token === "object" ? replacementSourcePreservationBindings.get(token) : undefined;
  const eventIds = idsOf(context.pending);
  if (!binding || token.kind !== "consumed_replacement_source" || token[replacementSourcePreservationBrand] !== true
    || binding.db !== db || binding.targetRunId !== executionRunId || token.companyId !== binding.companyId
    || token.missionId !== binding.missionId || token.workflowId !== binding.workflowId
    || token.sourceRunId !== binding.sourceRunId || token.targetRunId !== binding.targetRunId
    || token.authorityId !== binding.authorityId || token.sourceAuthorityVersion !== binding.sourceAuthorityVersion
    || token.targetAuthorityVersion !== binding.targetAuthorityVersion
    || !isDeepStrictEqual(token.sourceEventIds, binding.sourceEventIds)) {
    throw hold("replacement_preservation_binding_unproven", eventIds);
  }
  const observedSourceIds: string[] = [];
  for (const item of context.pending) {
    const preparation = item.preparation;
    if (preparation.workflowRunId === binding.sourceRunId) {
      if (preparation.companyId !== binding.companyId || preparation.missionId !== binding.missionId
        || preparation.workflowRunId !== binding.sourceRunId) {
        throw hold("replacement_preservation_inventory_scope", [item.eventId]);
      }
      observedSourceIds.push(item.eventId);
    }
    if (preparation.workflowRunId === binding.targetRunId
      && (preparation.companyId !== binding.companyId || preparation.missionId !== binding.missionId)) {
      throw hold("replacement_preservation_inventory_scope", [item.eventId]);
    }
  }
  if (!isDeepStrictEqual(sorted(observedSourceIds), binding.sourceEventIds)) {
    throw hold("replacement_preservation_inventory_changed", [...binding.sourceEventIds, ...observedSourceIds]);
  }
  const sourceIds = new Set(binding.sourceEventIds);
  return context.pending.filter(item => !sourceIds.has(item.eventId));
}

async function revalidateReplacementSourcePreservation(db: Db, context: QaRemediationAdmissionContext,
  executionRunId: string | null): Promise<void> {
  const token = context.replacementSourcePreservation;
  if (!token) return;
  const binding = replacementSourcePreservationBindings.get(token);
  const eventIds = idsOf(context.pending);
  if (!binding || binding.db !== db || binding.targetRunId !== executionRunId) {
    throw hold("replacement_preservation_binding_unproven", eventIds);
  }
  const currentScope = await discoverScope(db, binding.targetRunId);
  const currentBinding = inspectReplacementSourcePreservation(db, currentScope, context.pending, binding.targetRunId);
  if (!currentBinding || !sameReplacementSourcePreservationBinding(binding, currentBinding)) {
    throw hold("replacement_preservation_authority_changed", [...binding.sourceEventIds, ...eventIds]);
  }
}

async function discoverScope(db: Db, runId: string): Promise<RootScope> {
  const [target] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!target) throw hold("run_missing", []);
  const authorities = await db.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.replacementRunId, runId));
  if (!target.missionId) {
    if (authorities.length || hasReplacementAuthorityMarker(target)) throw hold("replacement_target_scope", []);
    return { target, source: null, authority: null };
  }
  if (authorities.length > 1) throw hold("replacement_authority_conflict", []);
  const authority = authorities[0] ?? null;
  if (!authority) {
    if (hasReplacementAuthorityMarker(target)) throw hold("replacement_authority_missing", []);
    return { target, source: null, authority: null };
  }
  if (!target.missionId) throw hold("replacement_target_scope", []);
  if (authority.recoveryKind !== "replacement_from_start_v1" || authority.status !== "consumed"
    || authority.resultingAuthorityVersion !== authority.targetAuthorityVersion
    || authority.companyId !== target.companyId || authority.replacementRunId !== target.id
    || authority.workflowRunId === target.id) {
    throw hold("replacement_authority_scope", []);
  }
  const [source] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, authority.workflowRunId));
  if (!source) throw hold("replacement_source_missing", []);
  if (source.companyId !== target.companyId || source.missionId !== target.missionId || source.workflowId !== target.workflowId
    || !source.missionId || source.id !== authority.workflowRunId) {
    throw hold("replacement_source_scope", []);
  }
  return { target, source, authority };
}

export async function discoverQaRemediationWorkflowScope(db: Db, runId: string): Promise<RootScope> {
  return discoverScope(db, runId);
}

async function inventoryForRun(db: Db, run: Run): Promise<Inventory> {
  const rows = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, run.id));
  const relevant = rows.filter(row => [QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_EVENT_TYPE,
    QA_REMEDIATION_COMPLETION_EVENT_TYPE].includes(row.eventType));
  const preparations = new Map<string, { row: typeof rows[number]; value: QaRemediationPreparation }>();
  const completions = relevant.filter(row => row.eventType === QA_REMEDIATION_COMPLETION_EVENT_TYPE);
  const legacy = relevant.filter(row => row.eventType === QA_REMEDIATION_EVENT_TYPE);
  for (const row of relevant.filter(row => row.eventType === QA_REMEDIATION_PREPARATION_EVENT_TYPE)) {
    let value: QaRemediationPreparation;
    try { value = parseQaRemediationPreparation(row.payload); }
    catch { throw hold("invalid_preparation", [row.id]); }
    if (row.id !== value.preparationId || row.layer !== "workflow_validation" || row.companyId !== value.companyId
      || row.missionId !== value.missionId || row.workflowRunId !== value.workflowRunId
      || row.workflowStepRunId !== value.producer.stepRunId || row.issueId !== value.producer.issueId
      || row.executionGeneration !== value.producer.executionGeneration || row.idempotencyKey !== qaRemediationPreparationKey(value)
      || value.companyId !== run.companyId || value.missionId !== run.missionId || value.workflowRunId !== run.id
      || preparations.has(row.id)) throw hold("preparation_binding", [row.id]);
    if ([...preparations.values()].some(item => qaRemediationPreparationKey(item.value) === qaRemediationPreparationKey(value))) {
      throw hold("conflicting_preparation", [row.id]);
    }
    preparations.set(row.id, { row, value: freezePreparation(value) });
  }
  const settled = new Set<string>();
  for (const row of completions) {
    const match = [...preparations.values()].find(item => row.idempotencyKey === qaRemediationCompletionKey(item.value));
    if (!match) throw hold("orphan_completion", [row.id]);
    const peers = completions.filter(other => other.idempotencyKey === row.idempotencyKey);
    if (peers.length !== 1) throw hold("conflicting_completion", [match.row.id, ...peers.map(peer => peer.id)]);
    const proof = await validateQaRemediationCompletionEvidence(db, row, match.value);
    if (!proof.ok) throw hold("invalid_completion", [match.row.id, row.id]);
    settled.add(match.row.id);
  }
  const c02Applications = legacy.filter(row => {
    const payload = row.payload as Record<string, unknown> | null;
    return payload?.schemaVersion === "workflow.qa-correction.applied.v1";
  }).sort((a, b) => a.id.localeCompare(b.id));
  const issuedC02: C02IssuedProof[] = [];
  for (const row of c02Applications) {
    let issued: IssuedQaCorrection;
    try {
      issued = await readIssuedQaCorrection(db, { companyId: run.companyId, workflowRunId: run.id, appliedEventId: row.id });
    } catch {
      throw hold("invalid_correction_application", [row.id]);
    }
    const preparation = issued.preparation;
    if (row.companyId !== run.companyId || row.missionId !== run.missionId || row.workflowRunId !== run.id
      || row.workflowStepRunId !== preparation.producer.stepRunId || row.issueId !== preparation.producer.issueId
      || row.executionGeneration !== preparation.producer.executionGeneration) {
      throw hold("correction_application_binding", [row.id]);
    }
    const verdicts: Array<C02IssuedProof["verdicts"][number]> = [];
    for (const authority of preparation.authority.verdicts) {
      try {
        const fact = await readQaCorrectionVerdict(db, preparation, authority, false);
        verdicts.push({ authority, items: fact.remediations.items });
      } catch {
        throw hold("invalid_correction_application", [row.id]);
      }
    }
    issuedC02.push({
      applicationEventId: row.id,
      issued,
      scope: {
        companyId: preparation.companyId, missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
        dispatchAuthorityVersion: preparation.dispatchAuthorityVersion, producer: preparation.producer,
        verdicts: preparation.authority.verdicts.map(verdict => ({
          eventId: verdict.eventId, heartbeatRunId: verdict.heartbeatRunId, qa: verdict.qa,
          remediationsHash: verdict.remediationsHash,
        })),
      },
      verdicts,
    });
  }
  const c02ApplicationIds = new Set(issuedC02.map(proof => proof.applicationEventId));
  for (const row of legacy) {
    if (c02ApplicationIds.has(row.id)) continue;
    const eventPayload = row.payload as Record<string, unknown>;
    const match = [...preparations.values()].find(item => item.value.verdicts.some(verdict =>
      verdict.eventId === eventPayload?.sourceVerdictEventId && verdict.qa.stepRunId === row.workflowStepRunId));
    const preparation = match?.value;
    const classified = preparation && classifyQaRemediationLegacyRow(row, {
      companyId: preparation.companyId, missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
      dispatchAuthorityVersion: preparation.dispatchAuthorityVersion, producer: preparation.producer,
      verdicts: preparation.verdicts,
    });
    if (match && classified?.kind === "legacy_effect") continue;

    const c02Matches = issuedC02.flatMap(proof => proof.verdicts
      .filter(verdict => verdict.authority.eventId === eventPayload?.sourceVerdictEventId
        && verdict.authority.qa.stepRunId === row.workflowStepRunId)
      .map(verdict => ({ proof, verdict })));
    if (c02Matches.length !== 1) throw hold("unresolved_legacy_effect", [row.id]);
    const [{ proof, verdict }] = c02Matches;
    const c02Classified = classifyQaRemediationLegacyRow(row, proof.scope);
    const expectedPayload = {
      kind: "qa_remediation_applied",
      outcome: "applied",
      producerStepId: proof.issued.preparation.producer.stepId,
      producerStepRunId: proof.issued.preparation.producer.stepRunId,
      producerIteration: proof.issued.preparation.producer.iterationIndex,
      qaStepId: verdict.authority.qa.stepId,
      sourceVerdictEventId: verdict.authority.eventId,
      appliedAt: proof.issued.applied.appliedAt,
      items: verdict.items,
      signatures: verdict.items.map(item => computeDefectSignature(item.find, item.replace)),
    };
    if (!c02Classified || c02Classified.kind !== "legacy_effect" || c02Classified.effect.outcome !== "applied"
      || c02Classified.effect.appliedAt !== proof.issued.applied.appliedAt
      || row.heartbeatRunId !== verdict.authority.heartbeatRunId
      || row.executionGeneration !== verdict.authority.qa.executionGeneration
      || row.createdAt.getTime() !== Date.parse(proof.issued.applied.appliedAt)
      || !isDeepStrictEqual(row.payload, expectedPayload)) {
      throw hold("unresolved_legacy_effect", [row.id]);
    }
  }
  const pending = Object.freeze([...preparations.entries()].filter(([id]) => !settled.has(id))
    .map(([eventId, item]) => Object.freeze({ eventId, preparation: item.value }))
    .sort((a, b) => a.eventId.localeCompare(b.eventId)));
  return {
    signature: JSON.stringify([...relevant].sort((a, b) => a.id.localeCompare(b.id))),
    pending,
    targets: sorted(pending.flatMap(item => item.preparation.files.map(file => file.path))),
    allTargets: sorted([...preparations.values()].flatMap(item => item.value.files.map(file => file.path))),
    hasHistory: relevant.length > 0,
  };
}

/** Only exact run evidence opts legacy sync into the shared transaction. */
export async function workflowRunHasC5AdmissionScope(db: Db, runId: string): Promise<boolean> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!run) return true;
  const [authority] = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, run.companyId), or(eq(workflowRecoveryAuthorities.workflowRunId, runId), eq(workflowRecoveryAuthorities.replacementRunId, runId)))).limit(1);
  const [history] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    inArray(workflowTransitionEvents.eventType, ["qa_remediation_prepared", "qa_remediation_completed", "qa_correction_prepared"])) ).limit(1);
  const [actual] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(workflowStepRuns, eq(workflowStepRuns.id, heartbeatRuns.workflowStepRunId)).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(workflowStepRuns.workflowRunId, runId), isNotNull(heartbeatRuns.executorOwnerId), isNotNull(heartbeatRuns.executionToken))).limit(1);
  const [held] = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, runId), inArray(workflowStepRuns.status, ["held", "blocked"])) ).limit(1);
  const inventory = await inventoryForRun(db, run);
  return Boolean(authority || history || actual || held || inventory.pending.length);
}

export async function hasPendingQaRemediationForRun(db: Db, run: Run): Promise<boolean> {
  return (await inventoryForRun(db, run)).pending.length > 0;
}

async function inventory(db: Db, runs: readonly Run[]): Promise<Inventory> {
  const results: Inventory[] = [];
  for (const run of runs) results.push(await inventoryForRun(db, run));
  const pending = Object.freeze(results.flatMap(result => result.pending)
    .sort((a, b) => a.eventId.localeCompare(b.eventId)));
  return {
    signature: JSON.stringify(results.map(result => result.signature)),
    pending,
    targets: sorted(results.flatMap(result => result.targets)),
    allTargets: sorted(results.flatMap(result => result.allTargets)),
    hasHistory: results.some(result => result.hasHistory),
  };
}

const lockedSourceSettlementContexts = new WeakMap<QaRemediationAdmissionContext, Db>();

export async function unresolvedQaRemediationAdmissionPending(db: Db, context: QaRemediationAdmissionContext,
  executionRunId?: string): Promise<readonly string[]> {
  const unresolved: string[] = [];
  const pending = executionRunId === undefined ? context.pending : blockingPending(context, db, executionRunId);
  for (const item of pending) {
    const rows = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, item.preparation.companyId),
      eq(workflowTransitionEvents.workflowRunId, item.preparation.workflowRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(item.preparation))));
    // Only the exact root callback below owns mission/source locks; diagnostic callers cannot exempt pending.
    if (rows.length === 0 && lockedSourceSettlementContexts.get(context) === db
      && executionRunId === item.preparation.workflowRunId) {
      const [replacement] = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRecoveryAuthorities.workflowRunId))
        .where(and(eq(workflowRecoveryAuthorities.companyId, item.preparation.companyId),
          eq(workflowRuns.companyId, item.preparation.companyId), eq(workflowRuns.missionId, item.preparation.missionId),
          eq(workflowRecoveryAuthorities.workflowRunId, executionRunId),
          eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"),
          eq(workflowRecoveryAuthorities.status, "consumed"))).limit(1);
      if (replacement) continue; // No completion/ACK/publication is invented; durable pending stays intact.
    }
    if (rows.length !== 1 || !(await validateQaRemediationCompletionEvidence(db, rows[0]!, item.preparation)).ok) {
      unresolved.push(item.eventId);
    }
  }
  return unresolved;
}

async function closeOwner(owner: QaRemediationFileOwner | null, onClosing?: () => void): Promise<CloseResult> {
  if (!owner) return { clean: true, exit: null };
  onClosing?.();
  try {
    const exit = await owner.close();
    return { clean: cleanExit(exit), exit };
  } catch (error) {
    return { clean: false, exit: null, error };
  }
}

class C5PreparationRefusal extends Error {
  constructor(readonly eventIds: readonly string[]) {
    super("qa_remediation_execution_preparation_pending");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function freezeExecutionScope(value: QaCorrectionExecutionScope): QaCorrectionExecutionScope {
  if (!value || !Array.isArray(value.workflowRunIds) || !Array.isArray(value.workflowRuns)
    || !Array.isArray(value.replacementAuthorities)) {
    throw hold("execution_scope_malformed", []);
  }
  if (value.kind === "unlinked") {
    if (value.primaryWorkflowRunId !== null || value.workflowRunIds.length || value.resolvedAttempt !== null
      || value.workflowRuns.length || value.replacementAuthorities.length) throw hold("execution_scope_malformed", []);
    if (value.missionId !== null && (typeof value.missionId !== "string" || !value.missionId)) {
      throw hold("execution_scope_malformed", []);
    }
    if (value.originalWake && (typeof value.originalWake.id !== "string" || !value.originalWake.id
      || typeof value.originalWake.companyId !== "string" || !value.originalWake.companyId
      || typeof value.originalWake.agentId !== "string" || !value.originalWake.agentId
      || (value.originalWake.issueId !== null && typeof value.originalWake.issueId !== "string")
      || (value.originalWake.missionId !== null && typeof value.originalWake.missionId !== "string")
      || (value.originalWake.runId !== null && typeof value.originalWake.runId !== "string")
      || (value.originalWake.workflowRunId !== null && typeof value.originalWake.workflowRunId !== "string")
      || (value.originalWake.workflowStepRunId !== null && typeof value.originalWake.workflowStepRunId !== "string")
      || (value.originalWake.workflowExecutionGeneration !== null
        && (!Number.isSafeInteger(value.originalWake.workflowExecutionGeneration) || value.originalWake.workflowExecutionGeneration < 0))
      || typeof value.originalWake.status !== "string")) throw hold("execution_scope_malformed", []);
    return deepFreeze({ kind: "unlinked" as const, primaryWorkflowRunId: null,
      workflowRunIds: [] as const, workflowRuns: [] as const, missionId: value.missionId, originalWake: value.originalWake,
      resolvedAttempt: null, replacementAuthorities: [] as const });
  }
  if (value.workflowRuns.some(run => !run || typeof run !== "object")
    || value.replacementAuthorities.some(item => !item || typeof item !== "object" || !item.authority)) {
    throw hold("execution_scope_malformed", []);
  }
  const resolvedProof = value.resolvedAttempt?.proof;
  if (value.kind !== "linked" || typeof value.primaryWorkflowRunId !== "string" || !value.primaryWorkflowRunId
    || !value.workflowRunIds.length || value.workflowRunIds.some(id => typeof id !== "string" || !id)
    || !value.workflowRunIds.includes(value.primaryWorkflowRunId)
    || new Set(value.workflowRunIds).size !== value.workflowRunIds.length
    || !isDeepStrictEqual(value.workflowRunIds, sorted(value.workflowRunIds))
    || value.workflowRuns.length !== value.workflowRunIds.length
    || value.workflowRuns.some((run, index) => !run.id || !run.companyId || !run.workflowId
      || (run.missionId !== null && typeof run.missionId !== "string")
      || !value.workflowRunIds.includes(run.id)
      || !Number.isSafeInteger(run.dispatchAuthorityVersion)
      || typeof run.status !== "string"
      || (index > 0 && `${value.workflowRuns[index - 1]!.missionId ?? ""}\u0000${value.workflowRuns[index - 1]!.id}`
        >= `${run.missionId ?? ""}\u0000${run.id}`))
    || !isDeepStrictEqual(value.workflowRuns.map(run => run.id).sort(), value.workflowRunIds)
    || !resolvedProof || resolvedProof.schemaVersion !== 1
    || typeof resolvedProof.companyId !== "string" || !resolvedProof.companyId
    || typeof resolvedProof.agentId !== "string" || !resolvedProof.agentId
    || (resolvedProof.issueId !== null && typeof resolvedProof.issueId !== "string")
    || (resolvedProof.missionId !== null && typeof resolvedProof.missionId !== "string")
    || !resolvedProof.stepRunId || !resolvedProof.workflowRunId
    || !Number.isSafeInteger(resolvedProof.executionGeneration) || resolvedProof.executionGeneration < 0
    || !Number.isSafeInteger(resolvedProof.retryCount) || resolvedProof.retryCount < 0
    || !Number.isSafeInteger(resolvedProof.iterationIndex) || resolvedProof.iterationIndex < 0
    || !resolvedProof.wakeupRequestId
    || !value.resolvedAttempt.originalWake.id || value.resolvedAttempt.originalWake.id !== resolvedProof.wakeupRequestId
    || value.resolvedAttempt.originalWake.companyId !== resolvedProof.companyId
    || value.resolvedAttempt.originalWake.agentId !== resolvedProof.agentId
    || value.resolvedAttempt.originalWake.runId === null
    || value.resolvedAttempt.originalWake.workflowRunId !== resolvedProof.workflowRunId
    || value.resolvedAttempt.originalWake.workflowStepRunId !== resolvedProof.stepRunId
    || value.resolvedAttempt.originalWake.workflowExecutionGeneration !== resolvedProof.executionGeneration
    || value.resolvedAttempt.retryCount !== resolvedProof.retryCount
    || value.resolvedAttempt.iterationIndex !== resolvedProof.iterationIndex
    || resolvedProof.workflowRunId !== value.primaryWorkflowRunId
    || value.replacementAuthorities.some((item, index) => !item.sourceRunId || !item.targetRunId
      || item.targetRunId === item.sourceRunId || item.authority.workflowRunId !== item.sourceRunId
      || item.authority.replacementRunId !== item.targetRunId
      || !value.workflowRunIds.includes(item.sourceRunId) || !value.workflowRunIds.includes(item.targetRunId)
      || (index > 0 && value.replacementAuthorities[index - 1]!.targetRunId >= item.targetRunId))) {
    throw hold("execution_scope_malformed", []);
  }
  return deepFreeze({ kind: "linked" as const, primaryWorkflowRunId: value.primaryWorkflowRunId,
    workflowRunIds: [...value.workflowRunIds], workflowRuns: [...value.workflowRuns], resolvedAttempt: value.resolvedAttempt,
    replacementAuthorities: [...value.replacementAuthorities] });
}

async function executionRuns(db: Db, root: RootScope | null, execution: QaCorrectionExecutionScope): Promise<Run[]> {
  if (execution.kind === "unlinked") {
    if (root) throw hold("execution_scope_unproven", []);
    return [];
  }
  if (!root) throw hold("execution_scope_unproven", []);
  const ids = sorted(execution.workflowRunIds);
  if (execution.primaryWorkflowRunId !== root.target.id
    || !execution.workflowRunIds.includes(root.target.id)
    || (root.source && !execution.workflowRunIds.includes(root.source.id))) {
    throw hold("execution_scope_unproven", []);
  }
  const rows = await db.select().from(workflowRuns).where(inArray(workflowRuns.id, ids))
    .orderBy(asc(workflowRuns.id));
  const runSnapshots = execution.workflowRuns.map(({ id, companyId, missionId, workflowId,
    dispatchAuthorityVersion, status }) => ({ id, companyId, missionId, workflowId, dispatchAuthorityVersion, status }))
    .sort((a, b) => (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id));
  const rowsById = new Map(rows.map(row => [row.id, row]));
  if (rows.length !== ids.length || rows.some(row => row.companyId !== root.target.companyId)
    || !isDeepStrictEqual(runSnapshots, execution.workflowRuns)
    || !isDeepStrictEqual(rows.map(({ id, companyId, missionId, workflowId, dispatchAuthorityVersion, status }) =>
      ({ id, companyId, missionId, workflowId, dispatchAuthorityVersion, status })).sort((a, b) =>
      (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id)), execution.workflowRuns)) {
    throw hold("execution_scope_changed", []);
  }
  const primaryAuthority = execution.replacementAuthorities.find(item => item.targetRunId === root.target.id)?.authority ?? null;
  if (!isDeepStrictEqual(primaryAuthority, root.authority)) throw hold("execution_authority_changed", []);
  if (root.source && !rowsById.has(root.source.id)) throw hold("execution_scope_unproven", []);
  return rows;
}

async function assertPendingActualsDrained(db: Db, context: QaRemediationAdmissionContext): Promise<void> {
  for (const item of context.pending) {
    const [producer] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, item.preparation.producer.stepRunId),
      eq(workflowStepRuns.workflowRunId, item.preparation.workflowRunId)));
    if (!producer) throw hold("execution_producer_missing", [item.eventId]);
    const drain = await readQaRemediationActualDrain(db, item.preparation, producer);
    if (drain.kind !== "proven") throw hold("execution_actual_drain_unproven", [item.eventId], drain);
  }
}

export type QaRemediationSharedAdmissionRuntime = {
  readonly ownerRuntime: QaFileOwnerRuntime;
  readonly outerNotifications: ReplacementRootNotifications;
  readonly resolutionMap: Map<string, unknown>;
  readonly bindResolutionMap: (notifications: ReplacementRootNotifications, map: Map<string, unknown>) => void;
  readonly driftBudget: { corrections: number };
};

type SharedAdmissionRootInput = QaRemediationSharedAdmissionRuntime & {
  readonly db: Db;
  readonly childCancellation?: ChildCancellationAdmission;
};

export function withQaRemediationSharedAdmission<T>(input: SharedAdmissionRootInput & {
  readonly runId: string | null;
  readonly execution: QaCorrectionExecutionStrategy<T>;
  readonly work?: never;
}): Promise<QaCorrectionExecutionBoundary<T>>;
export function withQaRemediationSharedAdmission<T>(input: SharedAdmissionRootInput & {
  readonly runId: string;
  readonly execution?: never;
  readonly work: (db: Db, context: QaRemediationAdmissionContext) => Promise<T>;
}): Promise<T>;
export async function withQaRemediationSharedAdmission<T>(input: SharedAdmissionRootInput & {
  readonly runId: string | null;
  readonly execution?: QaCorrectionExecutionStrategy<T>;
  readonly work?: (db: Db, context: QaRemediationAdmissionContext) => Promise<T>;
}): Promise<T | QaCorrectionExecutionBoundary<T>> {
  const { db, runId } = input;
  if (is(db, PgTransaction)) {
    if (input.execution) {
      registerQaCorrectionRootDrain(db, input.execution.identity.agentId);
      return { kind: "root_deferred" };
    }
    if (input.childCancellation) throw hold("cancel_transaction_root_required", []);
    if (!input.work) throw new Error("qa_remediation_admission_work_required");
    return input.work(db, { pending: [] });
  }

  for (;;) {
    const execution = input.execution;
    const executionScope = execution ? freezeExecutionScope(await execution.discoverScope(db)) : null;
    const unlinkedExecution = executionScope?.kind === "unlinked";
    if (!execution && !runId) throw new Error("qa_remediation_admission_run_required");
    if (executionScope?.kind === "linked" && runId !== executionScope.primaryWorkflowRunId) {
      throw hold("execution_primary_scope_changed", []);
    }
    if (executionScope?.kind === "unlinked" && runId !== null) throw hold("execution_unlinked_run_id_unexpected", []);
    const linkedRunId = executionScope?.kind === "linked" ? executionScope.primaryWorkflowRunId : runId;
    // Linked authority and run scopes are rediscovered before every native-owner acquisition.
    const scope = unlinkedExecution ? null : linkedRunId ? await discoverScope(db, linkedRunId) : null;
    if (execution && !unlinkedExecution && !scope) throw hold("execution_primary_scope_unproven", []);
    if (execution && !executionScope) throw hold("execution_scope_unproven", []);
    if (!execution && !scope) throw hold("execution_primary_scope_unproven", []);
    const childCancellation = input.childCancellation;
    if (execution && childCancellation) throw hold("execution_child_cancellation_conflict", []);
    if (childCancellation) {
      if (!scope) throw hold("cancel_child_target_scope_unproven", []);
      if (scope.target.id !== childCancellation.identity.childRunId
        || scope.target.companyId !== childCancellation.identity.companyId) {
        throw hold("cancel_child_target_scope_unproven", []);
      }
      if (scope.source) throw hold("cancel_replacement_source_lock_prefix_unproven", []);
      const discovered = await childCancellation.discoverChild(db, linkedRunId!);
      if (!discovered || !isDeepStrictEqual(discovered.identity, childCancellation.identity)) {
        throw hold("cancel_child_identity_unproven", []);
      }
    }
    let before: Inventory;
    if (execution && executionScope) {
      const runs = await executionRuns(db, scope, executionScope);
      before = await inventory(db, runs);
      if (scope && !scope.target.missionId && before.hasHistory) throw hold("missionless_related_history", idsOf(before.pending));
    } else {
      if (!scope) throw hold("execution_primary_scope_unproven", []);
      if (!scope.target.missionId) {
        const unscoped = await inventory(db, [scope.target]);
        if (unscoped.hasHistory) throw hold("missionless_related_history", idsOf(unscoped.pending));
        if (!childCancellation) {
          if (!input.work) throw new Error("qa_remediation_admission_work_required");
          return input.work(db, { pending: [] });
        }
        before = unscoped;
      } else {
        const runs = scope.source ? [scope.source, scope.target] : [scope.target];
        before = await inventory(db, runs);
      }
    }
    const eventIds = idsOf(before.pending);
    const ownerTargets = execution || scope?.source ? before.allTargets : before.targets;
    let owner: QaRemediationFileOwner | null = null;
    let callbackEntrySealed = false;
    let ownerClosing = false;
    let unexpectedOwnerExit: FileOwnerExit | null | undefined;
    let callbackEntered = false;
    let callbackSettled = false;
    let callbackFailurePresent = false;
    let callbackFailure: unknown;
    let invocationTokenEntered = false;
    let adapterInvoked = false;
    let c5ScopeVersion: string | null = null;
    let nativeOwnerForProof: QaRemediationFileOwner | null = null;
    const privateNotificationState: { current: ReplacementRootNotifications | null } = { current: null };
    let settleCallback!: () => void;
    const callbackSettlement = new Promise<void>(resolve => { settleCallback = resolve; });

    try {
      if (ownerTargets.length) {
        owner = await input.ownerRuntime.begin(ownerTargets);
        if (!isDeepStrictEqual([...owner.targets()], ownerTargets)) {
          throw hold("owner_target_mismatch", eventIds);
        }
        nativeOwnerForProof = owner;
      }
      if (owner) {
        void owner.awaitExit().then(exit => {
          if (!ownerClosing) {
            callbackEntrySealed = true;
            unexpectedOwnerExit = exit;
          }
        }, () => {
          if (!ownerClosing) {
            callbackEntrySealed = true;
            unexpectedOwnerExit = null;
          }
        });
      }

      let value!: T | QaCorrectionExecutionBoundary<T>;
      try {
        value = await db.transaction(async tx => {
          callbackEntered = true;
          try {
            if (callbackEntrySealed) throw hold("owner_lost_before_callback", eventIds);
            const t = tx as unknown as Db;
            if (execution && executionScope) {
              const context = { pending: before.pending };
              if (!await execution.admit(t, executionScope, context)) {
                return { kind: "not_claimed" as const };
              }
              const currentRootScope = executionScope.kind === "unlinked" ? null : await discoverScope(t, linkedRunId!);
              const currentExecutionScope = freezeExecutionScope(await execution.discoverScope(t));
              if (!isDeepStrictEqual(currentRootScope, scope)
                || !isDeepStrictEqual(currentExecutionScope, executionScope)) throw new InventoryDrift();
              const relatedRuns = await executionRuns(t, currentRootScope, currentExecutionScope);
              const after = await inventory(t, relatedRuns);
              if (after.signature !== before.signature || !isDeepStrictEqual(after.pending, before.pending)
                || !isDeepStrictEqual(after.allTargets, before.allTargets)) throw new InventoryDrift();
              if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_before_callback", eventIds);
              const workContext: QaRemediationAdmissionContext = currentExecutionScope.kind === "linked"
                ? admissionContext(t, currentRootScope, after.pending, currentExecutionScope.primaryWorkflowRunId)
                : Object.freeze({ pending: after.pending });
              c5ScopeVersion = JSON.stringify([execution.identity, currentExecutionScope, after.signature, after.allTargets,
                workContext.replacementSourcePreservation ?? null]);
              const blocking = blockingPending(workContext, t, currentExecutionScope.primaryWorkflowRunId);
              if (blocking.length) {
                await assertPendingActualsDrained(t, { pending: blocking });
                throw new C5PreparationRefusal(idsOf(blocking));
              }

              const invokeOnce: QaCorrectionExecutionInvokeOnce = async <R>(execute: () => Promise<R>) => {
                if (execution.phase !== "adapter_start") throw new Error("qa_correction_invoke_once_outside_adapter_start");
                if (invocationTokenEntered) throw new Error("qa_correction_adapter_invocation_already_sealed");
                invocationTokenEntered = true;
                await execution.validateInvocation(t, currentExecutionScope, workContext);
                await revalidateReplacementSourcePreservation(t, workContext, currentExecutionScope.primaryWorkflowRunId);
                let actual: unknown;
                adapterInvoked = true;
                actual = execute();
                let then: unknown;
                try { then = actual && (actual as { then?: unknown }).then; }
                catch (error) { throw error; }
                if (!actual || typeof then !== "function") throw new Error("qa_correction_adapter_promise_missing");
                const result = Promise.resolve(actual as Promise<R>);
                void result.catch(() => undefined);
                return Object.freeze({ result });
              };
              const notifications = createReplacementRootNotifications();
              privateNotificationState.current = notifications;
              input.bindResolutionMap(notifications, input.resolutionMap);
              const result = await withReplacementRootNotificationDb(t, notifications, async () => {
                if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_before_callback", eventIds);
                const workResult = await execution.work(t, currentExecutionScope, workContext, invokeOnce);
                if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_during_callback", eventIds);
                return { kind: "performed" as const, value: workResult };
              });
              return result;
            }
            if (!scope) throw hold("execution_primary_scope_unproven", eventIds);
            const work = input.work;
            if (!work) throw new Error("qa_remediation_admission_work_required");
            if (childCancellation) await childCancellation.setChildLockTimeouts(t);
            if (scope.target.missionId) {
              const [mission] = await tx.select({ id: missions.id }).from(missions)
                .where(and(eq(missions.id, scope.target.missionId), eq(missions.companyId, scope.target.companyId))).for("update");
              if (!mission) throw hold("mission_scope_changed", eventIds);
            }

            let lockedSource: Run | null = null;
            let lockedTarget: Run | null = null;
            if (childCancellation) {
              const lockedChild = await childCancellation.lockChildIdentity(t, childCancellation.identity);
              if (!lockedChild) throw hold("cancel_child_identity_changed", eventIds);
              lockedTarget = lockedChild.child;
              if (lockedTarget.id !== scope.target.id || lockedTarget.companyId !== scope.target.companyId
                || lockedTarget.missionId !== scope.target.missionId || lockedTarget.workflowId !== scope.target.workflowId) {
                throw hold("cancel_child_target_scope_changed", eventIds);
              }
              const freshIdentity = await childCancellation.discoverChild(t, scope.target.id);
              if (!freshIdentity || !isDeepStrictEqual(freshIdentity.identity, childCancellation.identity)) {
                throw hold("cancel_child_identity_changed", eventIds);
              }
            } else {
              if (scope.source) {
                const [sourceRow] = await tx.select().from(workflowRuns)
                  .where(eq(workflowRuns.id, scope.source.id)).for("update");
                if (!sourceRow || sourceRow.companyId !== scope.target.companyId
                  || sourceRow.missionId !== scope.target.missionId || sourceRow.workflowId !== scope.target.workflowId
                  || sourceRow.workflowId !== scope.source.workflowId) {
                  throw hold("replacement_source_scope_changed", eventIds);
                }
                lockedSource = sourceRow;
              }
              const [targetRow] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, scope.target.id)).for("update");
              if (!targetRow || targetRow.companyId !== scope.target.companyId
                || targetRow.missionId !== scope.target.missionId || targetRow.workflowId !== scope.target.workflowId) {
                throw hold("target_scope_changed", eventIds);
              }
              lockedTarget = targetRow;
            }

            const currentAuthorities = await tx.select().from(workflowRecoveryAuthorities)
              .where(eq(workflowRecoveryAuthorities.replacementRunId, scope.target.id)).for("share");
            if (currentAuthorities.length > 1
              || !isDeepStrictEqual(currentAuthorities[0] ?? null, scope.authority)) throw new InventoryDrift();
            if (scope.authority) {
              if (!lockedSource || lockedSource.id !== scope.authority.workflowRunId
                || lockedSource.companyId !== lockedTarget.companyId
                || lockedSource.missionId !== lockedTarget.missionId) throw hold("replacement_source_scope_changed", eventIds);
            }

            const after = await inventory(t, scope.source ? [lockedSource!, lockedTarget!] : [lockedTarget!]);
            if (after.signature !== before.signature || !isDeepStrictEqual(after.pending, before.pending)
              || !isDeepStrictEqual(after.targets, before.targets)
              || (scope.source && !isDeepStrictEqual(after.allTargets, before.allTargets))) {
              throw new InventoryDrift();
            }
            if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_before_callback", eventIds);
            const lockedScope: RootScope = { target: lockedTarget!, source: lockedSource,
              authority: currentAuthorities[0] ?? null };
            const workContext = admissionContext(t, lockedScope, after.pending, lockedTarget!.id);
            lockedSourceSettlementContexts.set(workContext, t);

            const notifications = createReplacementRootNotifications();
            privateNotificationState.current = notifications;
            input.bindResolutionMap(notifications, input.resolutionMap);
            const result = await withReplacementRootNotificationDb(t, notifications,
              async () => {
                if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_before_callback", eventIds);
                const workResult = await work(t, workContext);
                if (callbackEntrySealed || unexpectedOwnerExit !== undefined) throw hold("owner_lost_during_callback", eventIds);
                return workResult;
              });
            return result;
          } catch (error) {
            callbackFailurePresent = true;
            callbackFailure = error;
            throw error;
          } finally {
            callbackSettled = true;
            settleCallback();
          }
        }, { isolationLevel: "read committed" });
      } catch (error) {
        callbackEntrySealed = true;
        if (callbackEntered && !callbackSettled) await callbackSettlement;
        const callbackProvedRollback = callbackEntered && callbackSettled && callbackFailurePresent && callbackFailure === error;
        const close = await closeOwner(owner, () => { ownerClosing = true; });
        owner = null;
        const primaryFailure = callbackFailurePresent ? callbackFailure : error;
        const transactionFailure = callbackFailurePresent && callbackFailure !== error ? error : undefined;
        const ownerCleanupFailure = close.error !== undefined ? close.error : !close.clean ? close.exit : undefined;
        const cleanupFailures: unknown[] = [];
        if (transactionFailure !== undefined) cleanupFailures.push(transactionFailure);
        if (ownerCleanupFailure !== undefined) cleanupFailures.push(ownerCleanupFailure);
        const cleanupFailure = cleanupFailures.length > 1
          ? new AggregateError(cleanupFailures, "transaction and native owner cleanup both failed")
          : cleanupFailures[0];
        if (!callbackProvedRollback) {
          if (!close.clean) throw hold("transaction_outcome_unknown", eventIds, primaryFailure, cleanupFailure);
          throw new UnknownTransactionOutcome(primaryFailure, transactionFailure);
        }
        if (!close.clean) throw hold("owner_exit_unknown", eventIds, error, close.error ?? close.exit);
        if (unexpectedOwnerExit !== undefined) throw hold("owner_exit_unknown", eventIds, error, unexpectedOwnerExit);
        if (execution && !adapterInvoked && error && typeof error === "object") {
          preInvocationRollbacks.set(error, { db, identity: execution.identity, phase: execution.phase });
        }
        if (error instanceof C5PreparationRefusal) {
          if (!execution || !c5ScopeVersion || !nativeOwnerForProof || invocationTokenEntered
            || transactionFailure !== undefined || !callbackProvedRollback) {
            throw hold("execution_not_invoked_proof_unavailable", error.eventIds, error, cleanupFailure);
          }
          return { kind: "c5_held_not_invoked", proof: mintC5NotInvokedProof({
            db,
            identity: execution.identity,
            phase: execution.phase,
            scope: executionScope!,
            scopeVersion: c5ScopeVersion,
            nativeOwner: nativeOwnerForProof,
          }) };
        }
        if (error instanceof InventoryDrift) {
          if (input.driftBudget.corrections < 2) {
            input.driftBudget.corrections++;
            continue;
          }
          throw hold("inventory_drift_exhausted", eventIds, error);
        }
        throw error;
      }

      if (!callbackEntered || !callbackSettled) {
        callbackEntrySealed = true;
        if (callbackEntered && !callbackSettled) await callbackSettlement;
        throw new UnknownTransactionOutcome(new Error("transaction callback settlement was not observed"));
      }
      if (unexpectedOwnerExit !== undefined) {
        const close = await closeOwner(owner, () => { ownerClosing = true; });
        owner = null;
        throw hold("owner_exit_unknown", eventIds, unexpectedOwnerExit, close.error ?? close.exit);
      }
      const close = await closeOwner(owner, () => { ownerClosing = true; });
      owner = null;
      if (!close.clean) throw hold("owner_exit_unknown", eventIds, close.error ?? close.exit);
      for (const id of privateNotificationState.current?.agentIds ?? []) input.outerNotifications.agentIds.add(id);
      for (const id of privateNotificationState.current?.correctionWakeupRequestIds ?? []) {
        input.outerNotifications.correctionWakeupRequestIds.add(id);
      }
      return value;
    } catch (error) {
      if (owner) {
        const close = await closeOwner(owner, () => { ownerClosing = true; });
        owner = null;
        if (!close.clean) throw hold("owner_exit_unknown", eventIds, error, close.error ?? close.exit);
      }
      if (error instanceof UnknownTransactionOutcome) {
        throw hold("transaction_outcome_unknown", eventIds, error.primary, error.transactionFailure);
      }
      if (unexpectedOwnerExit !== undefined) throw hold("owner_exit_unknown", eventIds, error, unexpectedOwnerExit);
      if (error instanceof InventoryDrift) {
        if (input.driftBudget.corrections < 2) {
          input.driftBudget.corrections++;
          continue;
        }
        throw hold("inventory_drift_exhausted", eventIds, error);
      }
      throw error;
    }
  }
}
