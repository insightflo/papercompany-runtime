import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { heartbeatRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE, type HeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import type { HeartbeatRun } from "./heartbeat-finalization/owner-capability.js";

export const TERMINAL_RELEASE_EVENT_TYPE = "heartbeat_terminal_release_continuation_v1";
export const TERMINAL_RELEASE_ACK_EVENT_TYPE = "heartbeat_terminal_release_ack_v1";
export const TERMINAL_RELEASE_REASON = "terminal_followup_deferred_for_actual_drain";
const MANIFEST_SCHEMA = "papercompany.heartbeat-terminal-release-continuation.v1";
const ACK_SCHEMA = "papercompany.heartbeat-terminal-release-ack.v1";
const uuid = z.string().uuid(), count = z.number().int().safe().nonnegative(), text = z.string().min(1);
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z.object({ companyId: uuid, missionId: uuid, workflowRunId: uuid, dispatchAuthorityVersion: count,
  workflowStepRunId: uuid, stepId: text, issueId: uuid, heartbeatRunId: uuid, wakeupRequestId: uuid,
  executionGeneration: count, retryCount: count, iterationIndex: count, executionScopeKind: text,
  executionEpoch: count, executionToken: uuid, executorOwnerId: text, ownerLeaseEpoch: count,
  ownerLeaseToken: uuid, retryOfRunId: uuid.nullable(), processLossRetryCount: count,
  ancestry: z.object({ rootHeartbeatRunId: uuid, rootWakeupRequestId: uuid }).strict() }).strict();
const sourceSchema = z.object({ companyId: uuid, missionId: uuid, workflowRunId: uuid, dispatchAuthorityVersion: count,
  workflowStepRunId: uuid, stepId: text, issueId: uuid, heartbeatRunId: uuid, wakeupRequestId: uuid,
  executionGeneration: count, retryCount: count, iterationIndex: count, executionScopeKind: text,
  executionEpoch: count, executorOwnerId: text, ownerLeaseEpoch: count, retryOfRunId: uuid.nullable(),
  processLossRetryCount: count, agentId: uuid, identityDigest: hex,
  ancestry: z.object({ rootHeartbeatRunId: uuid, rootWakeupRequestId: uuid }).strict() }).strict();
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sync_issue"), companyId: uuid, issueId: uuid }).strict(),
  z.object({ kind: z.literal("promote_issue_wakes"), companyId: uuid, issueId: uuid }).strict(),
  z.object({ kind: z.literal("promote_agent_queue"), companyId: uuid, agentId: uuid }).strict(),
  z.object({ kind: z.literal("unblock_handback"), companyId: uuid, issueId: uuid, agentId: uuid.nullable() }).strict(),
  z.object({ kind: z.literal("missing_evidence"), companyId: uuid, issueId: uuid, agentId: uuid,
    missionId: uuid.nullable(), attempt: count, requiredAction: text.max(120) }).strict(),
  z.object({ kind: z.literal("reevaluate_source") }).strict(),
]);
const stageSchema = z.enum(["issue_promotion", "workflow_evidence_sync"]);
const obligationSchema = z.object({ stage: stageSchema, effectKey: text, action: actionSchema }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(MANIFEST_SCHEMA), source: sourceSchema,
  obligations: z.array(obligationSchema).min(4).max(32) }).strict();
const receiptSchema = z.object({ schemaVersion: z.literal("workflow.heartbeat-actual-drain.v1"),
  identity: identitySchema, actual: z.object({ outcome: z.enum(["fulfilled", "rejected"]),
    observedAt: z.string().datetime({ offset: true }) }).strict(),
  cleanup: z.object({ runtimeServicesRelease: z.object({ called: z.literal(true), succeeded: z.literal(true) }).strict(),
    heartbeatSettlement: z.object({ called: z.literal(true), succeeded: z.literal(true) }).strict(),
    resources: z.object({ workspaceOperationsSettled: z.literal(true), runtimeServicesStopped: z.literal(true),
      missionRuntimeIdle: z.literal(true) }).strict() }).strict() }).strict();
const ackSchema = z.object({ schemaVersion: z.literal(ACK_SCHEMA), continuationEventId: uuid,
  sourceDigest: hex, effectKey: text, actualOutcome: z.enum(["fulfilled", "rejected"]) }).strict();
type EventDb = Pick<Db, "select" | "insert">;
export type TerminalReleaseStage = z.infer<typeof stageSchema>;
export type TerminalFollowup = z.infer<typeof actionSchema>;
export type TerminalReleaseObligationInput = { stage: TerminalReleaseStage; action: TerminalFollowup };
export type TerminalReleaseManifest = z.infer<typeof manifestSchema>;
export type TerminalReleaseManifestRead = { kind: "found"; eventId: string; manifest: TerminalReleaseManifest }
  | { kind: "held"; reason: string };
export type TerminalReleaseReadyRead = { kind: "ready"; eventId: string; manifest: TerminalReleaseManifest;
  actualOutcome: "fulfilled" | "rejected" } | { kind: "held"; reason: string };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const manifestKey = (source: z.infer<typeof sourceSchema>) => `heartbeat-terminal-release:v1:${source.heartbeatRunId}:${source.identityDigest}`;
const receiptKey = (source: z.infer<typeof sourceSchema>) => `heartbeat-actual-drained:v1:${source.heartbeatRunId}:${source.identityDigest}`;
const ackKey = (source: z.infer<typeof sourceSchema>, effectKey: string) =>
  `heartbeat-terminal-release-ack:v1:${source.heartbeatRunId}:${source.identityDigest}:${hash(effectKey)}`;

function freezeSource(input: HeartbeatActualDrainIdentity, agentId: string): z.infer<typeof sourceSchema> {
  const identity = identitySchema.parse(input);
  return sourceSchema.parse({ companyId: identity.companyId, missionId: identity.missionId,
    workflowRunId: identity.workflowRunId, dispatchAuthorityVersion: identity.dispatchAuthorityVersion,
    workflowStepRunId: identity.workflowStepRunId, stepId: identity.stepId, issueId: identity.issueId,
    heartbeatRunId: identity.heartbeatRunId, wakeupRequestId: identity.wakeupRequestId,
    executionGeneration: identity.executionGeneration, retryCount: identity.retryCount,
    iterationIndex: identity.iterationIndex, executionScopeKind: identity.executionScopeKind,
    executionEpoch: identity.executionEpoch, executorOwnerId: identity.executorOwnerId,
    ownerLeaseEpoch: identity.ownerLeaseEpoch, retryOfRunId: identity.retryOfRunId,
    processLossRetryCount: identity.processLossRetryCount, agentId, identityDigest: hash(identity), ancestry: identity.ancestry });
}

function expectedEffectKey(source: z.infer<typeof sourceSchema>, index: number, stage: string, action: unknown) {
  return `heartbeat-terminal-effect:v1:${source.heartbeatRunId}:${source.identityDigest}:${index}:${stage}:${hash(action)}`;
}

function compatible(stage: TerminalReleaseStage, kind: string) {
  return stage === "issue_promotion" ? kind === "promote_issue_wakes" || kind === "promote_agent_queue"
    : kind === "sync_issue" || kind === "unblock_handback" || kind === "missing_evidence" || kind === "reevaluate_source";
}

function validManifest(value: unknown): TerminalReleaseManifest | null {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) return null;
  const { source, obligations } = parsed.data;
  const seen = new Set<string>();
  for (const [index, item] of obligations.entries()) {
    const { action } = item;
    if (!compatible(item.stage, action.kind) || item.effectKey !== expectedEffectKey(source, index, item.stage, action)) return null;
    const actionCompany = "companyId" in action ? action.companyId : source.companyId;
    const actionIssue = "issueId" in action ? action.issueId : source.issueId;
    if (actionCompany !== source.companyId || actionIssue !== source.issueId) return null;
    if (action.kind === "promote_agent_queue" && action.agentId !== source.agentId) return null;
    if (action.kind === "missing_evidence" && (action.agentId !== source.agentId || action.missionId !== source.missionId)) return null;
    const signature = JSON.stringify([item.stage, action]);
    if (seen.has(signature)) return null;
    seen.add(signature);
  }
  const has = (stage: string, kind: string) => obligations.some(item => item.stage === stage && item.action.kind === kind);
  if (!has("issue_promotion", "promote_issue_wakes") || !has("issue_promotion", "promote_agent_queue")
    || !has("workflow_evidence_sync", "sync_issue") || !has("workflow_evidence_sync", "reevaluate_source")) return null;
  return parsed.data;
}

/** Freeze exact attempt identity as IDs plus a digest; execution and lease tokens are never copied. */
export function createTerminalReleaseManifest(identity: HeartbeatActualDrainIdentity, agentId: string,
  obligations: readonly TerminalReleaseObligationInput[]): TerminalReleaseManifest {
  const source = freezeSource(identity, agentId);
  const body = { schemaVersion: MANIFEST_SCHEMA, source, obligations: obligations.map((item, index) => {
    const parsed = z.object({ stage: stageSchema, action: actionSchema }).strict().parse(item);
    return { ...parsed, effectKey: expectedEffectKey(source, index, parsed.stage, parsed.action) };
  }) };
  const manifest = validManifest(body);
  if (!manifest) throw new Error("terminal_release_manifest_invalid_or_incomplete");
  return manifest;
}

function eventMatches(row: typeof workflowTransitionEvents.$inferSelect, source: z.infer<typeof sourceSchema>,
  eventType: string, reasonCode: string, idempotencyKey: string, correlationId: string | null,
  options: { allowNullWakeupRequestId?: boolean } = {}) {
  return row.companyId === source.companyId && row.missionId === source.missionId && row.workflowRunId === source.workflowRunId
    && row.workflowStepRunId === source.workflowStepRunId && row.issueId === source.issueId
    && (row.wakeupRequestId === source.wakeupRequestId
      || (options.allowNullWakeupRequestId === true && row.wakeupRequestId === null))
    && row.heartbeatRunId === source.heartbeatRunId
    && row.dispatchOwnerHeartbeatRunId === source.heartbeatRunId && row.executorOwnerId === source.executorOwnerId
    && row.executionGeneration === source.executionGeneration && row.eventType === eventType && row.layer === "heartbeat"
    && row.reasonCode === reasonCode && row.idempotencyKey === idempotencyKey && row.correlationId === correlationId;
}

function manifestEvent(row: typeof workflowTransitionEvents.$inferSelect): TerminalReleaseManifest | null {
  const manifest = validManifest(row.payload);
  if (!manifest || !eventMatches(row, manifest.source, TERMINAL_RELEASE_EVENT_TYPE, TERMINAL_RELEASE_REASON,
    manifestKey(manifest.source), manifestKey(manifest.source)) || row.reason !== TERMINAL_RELEASE_REASON) return null;
  return manifest;
}

/** Call with the release transaction so a missing/mismatched durable event aborts that transaction. */
export async function writeTerminalReleaseManifest(db: EventDb, value: unknown): Promise<{ eventId: string; created: boolean }> {
  const manifest = validManifest(value);
  if (!manifest) throw new Error("terminal_release_manifest_invalid_or_incomplete");
  const { source } = manifest, idempotencyKey = manifestKey(source);
  const inserted = await db.insert(workflowTransitionEvents).values({ companyId: source.companyId, missionId: source.missionId,
    workflowRunId: source.workflowRunId, workflowStepRunId: source.workflowStepRunId, issueId: source.issueId,
    wakeupRequestId: source.wakeupRequestId, heartbeatRunId: source.heartbeatRunId,
    dispatchOwnerHeartbeatRunId: source.heartbeatRunId, executorOwnerId: source.executorOwnerId,
    executionGeneration: source.executionGeneration, eventType: TERMINAL_RELEASE_EVENT_TYPE, layer: "heartbeat",
    reason: TERMINAL_RELEASE_REASON, reasonCode: TERMINAL_RELEASE_REASON, correlationId: idempotencyKey,
    idempotencyKey, payload: manifest }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.idempotencyKey, idempotencyKey)));
  const existing = rows.length === 1 ? manifestEvent(rows[0]!) : null;
  if (!existing || !isDeepStrictEqual(existing, manifest)) {
    throw new Error("terminal_release_manifest_durable_reentry_mismatch");
  }
  return { eventId: rows[0]!.id, created: inserted.length > 0 };
}

/** Read before release reentry; a found exact event means the release transaction must not run again. */
export async function readTerminalReleaseManifestForSource(db: Pick<Db, "select">,
  identity: HeartbeatActualDrainIdentity, agentId: string): Promise<TerminalReleaseManifestRead | { kind: "absent" }> {
  const source = freezeSource(identity, agentId), key = manifestKey(source);
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, key)));
  if (rows.length === 0) return { kind: "absent" };
  const manifest = rows.length === 1 ? manifestEvent(rows[0]!) : null;
  return manifest && isDeepStrictEqual(manifest.source, source)
    ? { kind: "found", eventId: rows[0]!.id, manifest }
    : { kind: "held", reason: "manifest_reentry_malformed_or_mismatched" };
}

export async function readTerminalReleaseManifest(db: Pick<Db, "select">, eventId: string): Promise<TerminalReleaseManifestRead> {
  if (!uuid.safeParse(eventId).success) return { kind: "held", reason: "manifest_id_malformed" };
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, eventId), eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE)));
  if (rows.length !== 1) return { kind: "held", reason: "manifest_missing_or_ambiguous" };
  const manifest = manifestEvent(rows[0]!);
  return manifest ? { kind: "found", eventId: rows[0]!.id, manifest } : { kind: "held", reason: "manifest_malformed_or_mismatched" };
}

export function terminalReleaseMatchesRun(source: TerminalReleaseManifest["source"], run: HeartbeatRun): boolean {
  if (run.id !== source.heartbeatRunId || run.companyId !== source.companyId || run.agentId !== source.agentId
    || run.issueId !== source.issueId || run.wakeupRequestId !== source.wakeupRequestId
    || run.workflowStepRunId !== source.workflowStepRunId || run.workflowExecutionGeneration !== source.executionGeneration
    || run.executionScopeKind !== source.executionScopeKind || run.executionEpoch !== source.executionEpoch
    || run.executorOwnerId !== source.executorOwnerId || run.executorOwnerLeaseEpoch !== source.ownerLeaseEpoch
    || run.retryOfRunId !== source.retryOfRunId || run.processLossRetryCount !== source.processLossRetryCount
    || !run.executionToken || !run.executorOwnerLeaseToken) return false;
  const identity = identitySchema.safeParse({ companyId: source.companyId, missionId: source.missionId,
    workflowRunId: source.workflowRunId, dispatchAuthorityVersion: source.dispatchAuthorityVersion,
    workflowStepRunId: source.workflowStepRunId, stepId: source.stepId, issueId: source.issueId,
    heartbeatRunId: source.heartbeatRunId, wakeupRequestId: source.wakeupRequestId,
    executionGeneration: source.executionGeneration, retryCount: source.retryCount, iterationIndex: source.iterationIndex,
    executionScopeKind: source.executionScopeKind, executionEpoch: source.executionEpoch, executionToken: run.executionToken,
    executorOwnerId: source.executorOwnerId, ownerLeaseEpoch: source.ownerLeaseEpoch,
    ownerLeaseToken: run.executorOwnerLeaseToken, retryOfRunId: source.retryOfRunId,
    processLossRetryCount: source.processLossRetryCount, ancestry: source.ancestry });
  return identity.success && hash(identity.data) === source.identityDigest;
}

export function terminalReleaseEffectKeys(manifest: TerminalReleaseManifest, stage: string): string[] {
  return manifest.obligations.filter(item => item.stage === stage).map(item => item.effectKey);
}

export async function readReadyTerminalReleaseContinuation(db: Pick<Db, "select">,
  eventId: string): Promise<TerminalReleaseReadyRead> {
  const loaded = await readTerminalReleaseManifest(db, eventId);
  if (loaded.kind !== "found") return loaded;
  const { manifest } = loaded, { source } = manifest;
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.heartbeatRunId, source.heartbeatRunId),
    eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, receiptKey(source))));
  if (rows.length !== 1) return { kind: "held", reason: "exact_actual_drain_receipt_missing_or_ambiguous" };
  const row = rows[0]!, parsed = receiptSchema.safeParse(row.payload);
  if (!parsed.success) return { kind: "held", reason: "exact_actual_drain_receipt_malformed_or_mismatched" };
  const exact = eventMatches(row, source, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE, "actual_drain_observed",
    receiptKey(source), null, { allowNullWakeupRequestId: true })
    && row.reason === "actual_adapter_settled_and_cleaned"
    && isDeepStrictEqual(freezeSource(parsed.data.identity, source.agentId), source);
  const [run] = exact ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, source.heartbeatRunId), eq(heartbeatRuns.companyId, source.companyId))) : [];
  if (!exact || !run || !terminalReleaseMatchesRun(source, run)) {
    return { kind: "held", reason: "exact_actual_drain_receipt_malformed_or_mismatched" };
  }
  return { kind: "ready", eventId, manifest, actualOutcome: parsed.data.actual.outcome };
}

function ackPayload(eventId: string, source: TerminalReleaseManifest["source"], effectKey: string,
  actualOutcome: "fulfilled" | "rejected") {
  return { schemaVersion: ACK_SCHEMA, continuationEventId: eventId, sourceDigest: source.identityDigest, effectKey, actualOutcome };
}

export type TerminalReleaseAckRead = { kind: "acknowledged"; eventId: string }
  | { kind: "pending" } | { kind: "held"; reason: string };

export async function readTerminalReleaseAcknowledgment(db: Pick<Db, "select">, continuationEventId: string,
  effectKey: string): Promise<TerminalReleaseAckRead> {
  const ready = await readReadyTerminalReleaseContinuation(db, continuationEventId);
  if (ready.kind !== "ready") return ready;
  if (!ready.manifest.obligations.some(item => item.effectKey === effectKey)) return { kind: "held", reason: "ack_effect_key_not_in_manifest" };
  const idempotencyKey = ackKey(ready.manifest.source, effectKey);
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, ready.manifest.source.companyId),
    eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
    eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_ACK_EVENT_TYPE)));
  if (rows.length === 0) return { kind: "pending" };
  const row = rows[0]!, payload = ackSchema.safeParse(row.payload);
  return rows.length === 1 && payload.success && isDeepStrictEqual(payload.data,
    ackPayload(continuationEventId, ready.manifest.source, effectKey, ready.actualOutcome))
    && eventMatches(row, ready.manifest.source, TERMINAL_RELEASE_ACK_EVENT_TYPE, "terminal_followup_handled",
      idempotencyKey, continuationEventId) && row.reason === "terminal_followup_handled"
    ? { kind: "acknowledged", eventId: row.id } : { kind: "held", reason: "ack_malformed_or_mismatched" };
}

/** Call after the existing root rereads the exact durable effect; this acknowledges handling only. */
export async function acknowledgeTerminalReleaseObligation(db: EventDb, continuationEventId: string,
  effectKey: string): Promise<{ kind: "written" | "existing"; eventId: string } | { kind: "held"; reason: string }> {
  const ready = await readReadyTerminalReleaseContinuation(db, continuationEventId);
  if (ready.kind !== "ready") return ready;
  if (!ready.manifest.obligations.some(item => item.effectKey === effectKey)) return { kind: "held", reason: "ack_effect_key_not_in_manifest" };
  const { source } = ready.manifest, idempotencyKey = ackKey(source, effectKey);
  const inserted = await db.insert(workflowTransitionEvents).values({ companyId: source.companyId, missionId: source.missionId,
    workflowRunId: source.workflowRunId, workflowStepRunId: source.workflowStepRunId, issueId: source.issueId,
    wakeupRequestId: source.wakeupRequestId, heartbeatRunId: source.heartbeatRunId,
    dispatchOwnerHeartbeatRunId: source.heartbeatRunId, executorOwnerId: source.executorOwnerId,
    executionGeneration: source.executionGeneration, eventType: TERMINAL_RELEASE_ACK_EVENT_TYPE, layer: "heartbeat",
    reason: "terminal_followup_handled", reasonCode: "terminal_followup_handled", correlationId: continuationEventId,
    idempotencyKey, payload: ackPayload(continuationEventId, source, effectKey, ready.actualOutcome) })
    .onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  const read = await readTerminalReleaseAcknowledgment(db, continuationEventId, effectKey);
  return read.kind === "acknowledged" ? { kind: inserted.length ? "written" : "existing", eventId: read.eventId }
    : { kind: "held", reason: read.kind === "held" ? read.reason : "ack_durable_write_unobserved" };
}
