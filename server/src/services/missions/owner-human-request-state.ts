// C08 state primitives. The caller owns one transaction, authorization/checkout and commit.
// Acquire any existing quality-prefix locks before authority, and card/continuation locks afterward.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { issues, missions, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { z } from "zod";
import { conflict } from "../../errors.js";
import { assertOwnerHumanOriginalDecision, type OwnerHumanAuthority } from "./owner-human-request-authority.js";
import {
  OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, ownerHumanCurrentKey, ownerHumanCurrentSchema,
  ownerHumanEndKey, ownerHumanEndSchema, ownerHumanLifetimeKey, ownerHumanLifetimeSchema,
  ownerHumanSubmissionSchema, sameOwnerHumanValue,
  type OwnerHumanCurrent, type OwnerHumanEnd, type OwnerHumanLifetime, type OwnerHumanScope, type OwnerHumanTx,
} from "./owner-human-request-contract.js";

type Event = typeof workflowTransitionEvents.$inferSelect;
export type OwnerHumanCurrentRecord = {
  pointerEventId: string; pointer: OwnerHumanCurrent; lifetime: OwnerHumanLifetime;
};
const fail = (reason: string): never => { throw conflict("Owner human request state conflict", { reason }); };
function decode<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fail("owner_human_request_corrupt");
  return parsed.data;
}
async function byKey(tx: OwnerHumanTx, companyId: string, key: string, lock = false) {
  const query = tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.idempotencyKey, key)));
  const rows = lock ? await query.for("update") : await query;
  return rows[0];
}
function header(row: Event, lifetime: OwnerHumanLifetime, kind: string, key: string) {
  if (row.companyId !== lifetime.scope.companyId || row.missionId !== lifetime.scope.missionId
    || row.eventType !== kind || row.layer !== OWNER_HUMAN_LAYER || row.reason !== OWNER_HUMAN_SOURCE
    || row.reasonCode !== OWNER_HUMAN_SOURCE || row.idempotencyKey !== key
    || row.issueId !== lifetime.anchorIssueId || row.heartbeatRunId !== lifetime.heartbeatRunId) {
    fail("owner_human_request_corrupt");
  }
}
async function lifetimeFromRow(tx: OwnerHumanTx, row: Event): Promise<OwnerHumanLifetime> {
  const lifetime = decode(ownerHumanLifetimeSchema, row.payload);
  header(row, lifetime, lifetime.kind, ownerHumanLifetimeKey(lifetime.requestKey));
  if (row.id !== lifetime.lifetimeId) fail("owner_human_request_corrupt");
  const card = lifetime.cardInput;
  if (card.companyId !== lifetime.scope.companyId || card.missionId !== lifetime.scope.missionId
    || card.decisionEventId !== lifetime.decisionEventId || card.ownerActionIssueId !== lifetime.anchorIssueId
    || card.requestedByAgentId !== lifetime.authorAgentId || card.sourceIssueId !== lifetime.sourceIssueId
    || card.decision !== lifetime.submission.decision || card.reason !== lifetime.submission.reason
    || card.nextAction !== lifetime.submission.nextAction || card.evidence !== lifetime.submission.evidence
    || card.recommendedOptionId !== lifetime.submission.recommendedOptionId
    || card.recommendationReason !== lifetime.submission.recommendationReason
    || (lifetime.scope.target.kind === "tool_step" && card.workflowRunId !== lifetime.scope.target.workflowRunId)) {
    fail("owner_human_request_corrupt");
  }
  await assertOwnerHumanOriginalDecision(tx, lifetime);
  return lifetime;
}

// The unique pointer is authoritative. Malformed/missing referenced records never fall back to history.
export async function readOwnerHumanCurrentForScope(
  tx: OwnerHumanTx,
  scope: OwnerHumanScope,
  options: { lockPointer: boolean },
): Promise<OwnerHumanCurrentRecord | null> {
  const row = await byKey(tx, scope.companyId, ownerHumanCurrentKey(scope), options.lockPointer);
  if (!row) return null;
  const pointer = decode(ownerHumanCurrentSchema, row.payload);
  if (!sameOwnerHumanValue(pointer.scope, scope)) fail("owner_human_request_corrupt");
  const [stored] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, pointer.lifetimeId), eq(workflowTransitionEvents.companyId, scope.companyId)));
  if (!stored) return fail("owner_human_request_corrupt");
  const lifetime = await lifetimeFromRow(tx, stored);
  header(row, lifetime, pointer.kind, ownerHumanCurrentKey(scope));
  if (!sameOwnerHumanValue(lifetime.scope, pointer.scope) || pointer.requestKey !== lifetime.requestKey
    || pointer.anchorIssueId !== lifetime.anchorIssueId) fail("owner_human_request_corrupt");
  const ended = await byKey(tx, scope.companyId, ownerHumanEndKey(lifetime.lifetimeId));
  if (pointer.recoveryNeeded) {
    if (ended) fail("owner_human_request_corrupt");
  } else {
    if (!ended || !pointer.closure) return fail("owner_human_request_corrupt");
    const ending = decode(ownerHumanEndSchema, ended.payload);
    header(ended, lifetime, ending.kind, ownerHumanEndKey(lifetime.lifetimeId));
    if (ended.id !== pointer.closure.eventId || ending.lifetimeId !== lifetime.lifetimeId
      || !sameOwnerHumanValue(ending.scope, pointer.scope) || ending.reason !== pointer.closure.reason
      || ending.nextLifetimeId !== null) fail("owner_human_request_corrupt");
  }
  return { pointerEventId: row.id, pointer, lifetime };
}

// Existing C08 writers retain their pointer row lock; read-only recovery callers opt out while
// already holding the mission prefix, avoiding a second authority lock-order traversal.
export async function readOwnerHumanCurrent(auth: OwnerHumanAuthority): Promise<OwnerHumanCurrentRecord | null> {
  return readOwnerHumanCurrentForScope(auth.tx, auth.scope, { lockPointer: true });
}

async function appendEnd(auth: OwnerHumanAuthority, lifetime: OwnerHumanLifetime,
  reason: OwnerHumanEnd["reason"], nextLifetimeId: string | null) {
  const payload: OwnerHumanEnd = { schemaVersion: 1, kind: "owner_human_end_v1",
    scope: lifetime.scope, lifetimeId: lifetime.lifetimeId, reason, nextLifetimeId };
  const [row] = await auth.tx.insert(workflowTransitionEvents).values({
    companyId: lifetime.scope.companyId, missionId: lifetime.scope.missionId,
    issueId: lifetime.anchorIssueId, heartbeatRunId: lifetime.heartbeatRunId,
    eventType: payload.kind, layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE,
    reasonCode: OWNER_HUMAN_SOURCE, idempotencyKey: ownerHumanEndKey(lifetime.lifetimeId), payload,
  }).returning({ id: workflowTransitionEvents.id });
  if (!row) return fail("owner_human_request_write_failed");
  return row.id;
}
async function writePointer(auth: OwnerHumanAuthority, previous: OwnerHumanCurrentRecord | null,
  pointer: OwnerHumanCurrent, lifetime: OwnerHumanLifetime) {
  const values = { companyId: auth.scope.companyId, missionId: auth.scope.missionId,
    issueId: lifetime.anchorIssueId, heartbeatRunId: lifetime.heartbeatRunId,
    eventType: pointer.kind, layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE,
    reasonCode: OWNER_HUMAN_SOURCE, idempotencyKey: ownerHumanCurrentKey(auth.scope), payload: pointer };
  const rows = previous
    ? await auth.tx.update(workflowTransitionEvents).set(values).where(and(
      eq(workflowTransitionEvents.id, previous.pointerEventId),
      eq(workflowTransitionEvents.companyId, auth.scope.companyId),
      eq(workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey(auth.scope)),
      sql`${workflowTransitionEvents.payload}->>'lifetimeId' = ${previous.pointer.lifetimeId}`,
      sql`${workflowTransitionEvents.payload}->>'revision' = ${String(previous.pointer.revision)}`,
    )).returning({ id: workflowTransitionEvents.id })
    : await auth.tx.insert(workflowTransitionEvents).values(values).onConflictDoNothing()
      .returning({ id: workflowTransitionEvents.id });
  if (rows.length !== 1) return fail("owner_human_request_current_changed");
  return { pointerEventId: rows[0]!.id, pointer, lifetime };
}

// A caller can read/replay before writing an original decision. For a new request, the supplied
// decision must have been written in this same transaction; any failure rolls the whole write back.
export async function saveOwnerHumanRequest(auth: OwnerHumanAuthority, input: {
  schemaVersion: 1; requestKey: string; expectedCurrentLifetimeId: string | null;
  identityMode: "keyed" | "legacy_exact"; decisionEventId: string; submission: unknown;
}): Promise<OwnerHumanCurrentRecord> {
  if (auth.purpose !== "submit" || input.schemaVersion !== 1 || !input.requestKey.trim()) {
    return fail("owner_human_request_invalid");
  }
  const submission = decode(ownerHumanSubmissionSchema, input.submission);
  if (!sameOwnerHumanValue(submission.recoveryTarget, auth.recoveryTarget)) fail("owner_human_request_target_mismatch");
  const previous = await readOwnerHumanCurrent(auth);
  const existing = await byKey(auth.tx, auth.scope.companyId, ownerHumanLifetimeKey(input.requestKey));
  if (existing) {
    const saved = await lifetimeFromRow(auth.tx, existing);
    if (saved.requestKey !== input.requestKey) fail("owner_human_request_key_conflict");
    if (!sameOwnerHumanValue(saved.scope, auth.scope)) fail("owner_human_request_scope_mismatch");
    if (!sameOwnerHumanValue(saved.submission, submission) || saved.identityMode !== input.identityMode) {
      fail("owner_human_request_key_conflict");
    }
    if (!previous || previous.lifetime.lifetimeId !== saved.lifetimeId || !previous.pointer.recoveryNeeded
      || saved.authorAgentId !== auth.agentId) return fail("owner_human_request_stale_key");
    return previous;
  }
  if (input.expectedCurrentLifetimeId !== (previous?.pointer.lifetimeId ?? null)) {
    return fail("owner_human_request_current_changed");
  }
  const lifetime = decode(ownerHumanLifetimeSchema, {
    schemaVersion: 1, kind: "owner_human_lifetime_v1", lifetimeId: randomUUID(), scope: auth.scope,
    requestKey: input.requestKey, identityMode: input.identityMode, decisionEventId: input.decisionEventId,
    anchorIssueId: auth.anchor.id, sourceIssueId: auth.source?.id ?? null,
    authorAgentId: auth.agentId, heartbeatRunId: auth.heartbeatRunId, submission,
    cardInput: { companyId: auth.scope.companyId, missionId: auth.scope.missionId,
      decisionEventId: input.decisionEventId, decision: submission.decision,
      ownerActionIssueId: auth.anchor.id, ownerActionIssueStatus: auth.anchor.status,
      requestedByAgentId: auth.agentId, reason: submission.reason, nextAction: submission.nextAction,
      evidence: submission.evidence, recommendedOptionId: submission.recommendedOptionId,
      recommendationReason: submission.recommendationReason,
      issueTitle: auth.anchor.title, issueIdentifier: auth.anchor.identifier,
      sourceIssueId: auth.source?.id ?? null, workflowRunId: auth.run?.id ?? null },
  });
  await assertOwnerHumanOriginalDecision(auth.tx, lifetime);
  const inserted = await auth.tx.insert(workflowTransitionEvents).values({
    id: lifetime.lifetimeId, companyId: auth.scope.companyId, missionId: auth.scope.missionId,
    issueId: lifetime.anchorIssueId, heartbeatRunId: lifetime.heartbeatRunId,
    eventType: lifetime.kind, layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE,
    reasonCode: OWNER_HUMAN_SOURCE, idempotencyKey: ownerHumanLifetimeKey(input.requestKey), payload: lifetime,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (inserted.length !== 1) return fail("owner_human_request_key_conflict");
  if (previous?.pointer.recoveryNeeded) await appendEnd(auth, previous.lifetime, "replaced", lifetime.lifetimeId);
  return writePointer(auth, previous, {
    schemaVersion: 1, kind: "owner_human_current_v1", scope: auth.scope,
    lifetimeId: lifetime.lifetimeId, requestKey: lifetime.requestKey, anchorIssueId: lifetime.anchorIssueId,
    revision: (previous?.pointer.revision ?? 0) + 1, recoveryNeeded: true, closure: null,
  }, lifetime);
}

// Stage 13A primitive only: the caller owns creation in this transaction and acquired the
// complete authority prefix (including both anchors) before reading the current pointer.
// Notifications/cards and producer integration stay with the following original stages.
export async function renewOwnerHumanRequest(auth: OwnerHumanAuthority, input: {
  requestKey: string; expectedCurrentLifetimeId: string;
}): Promise<OwnerHumanCurrentRecord> {
  const next = auth.renewalAnchor;
  if (auth.purpose !== "renew" || !auth.renewal || !next
    || input.expectedCurrentLifetimeId !== auth.renewal.previousLifetimeId) {
    return fail("owner_human_request_invalid");
  }
  const previous = await readOwnerHumanCurrent(auth);
  if (!previous?.pointer.recoveryNeeded || previous.lifetime.authorAgentId !== auth.agentId) {
    return fail("owner_human_request_recovery_still_needed");
  }
  const old = previous.lifetime;
  // Response loss/restart reuses the committed successor, never another key or lifetime.
  if (old.renewal?.previousLifetimeId === input.expectedCurrentLifetimeId
    && old.anchorIssueId === next.id && old.requestKey === input.requestKey) return previous;
  if (old.lifetimeId !== input.expectedCurrentLifetimeId || old.anchorIssueId !== auth.anchor.id) {
    return fail("owner_human_request_current_changed");
  }
  if (await byKey(auth.tx, auth.scope.companyId, ownerHumanLifetimeKey(input.requestKey))) {
    return fail("owner_human_request_key_conflict");
  }
  const lifetime = decode(ownerHumanLifetimeSchema, {
    ...old, lifetimeId: randomUUID(), requestKey: input.requestKey, identityMode: "keyed",
    anchorIssueId: next.id,
    renewal: { schemaVersion: 1, previousLifetimeId: old.lifetimeId },
    cardInput: { ...old.cardInput, ownerActionIssueId: next.id, ownerActionIssueStatus: next.status,
      issueTitle: next.title, issueIdentifier: next.identifier },
  });
  const rows = await auth.tx.insert(workflowTransitionEvents).values({
    id: lifetime.lifetimeId, companyId: auth.scope.companyId, missionId: auth.scope.missionId,
    issueId: lifetime.anchorIssueId, heartbeatRunId: lifetime.heartbeatRunId,
    eventType: lifetime.kind, layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE,
    reasonCode: OWNER_HUMAN_SOURCE, idempotencyKey: ownerHumanLifetimeKey(lifetime.requestKey), payload: lifetime,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (rows.length !== 1) return fail("owner_human_request_key_conflict");
  await appendEnd(auth, old, "replaced", lifetime.lifetimeId);
  await assertOwnerHumanOriginalDecision(auth.tx, lifetime);
  return writePointer(auth, previous, {
    schemaVersion: 1, kind: "owner_human_current_v1", scope: auth.scope,
    lifetimeId: lifetime.lifetimeId, requestKey: lifetime.requestKey, anchorIssueId: lifetime.anchorIssueId,
    revision: previous.pointer.revision + 1, recoveryNeeded: true, closure: null,
  }, lifetime);
}

// Human-card `resolved` is deliberately not an ending fact. Native source/mission settlement owns
// this operation. Re-read already locked rows so a native update earlier in the same transaction counts.
export async function closeOwnerHumanRequest(auth: OwnerHumanAuthority, expectedCurrentLifetimeId: string) {
  if (auth.purpose !== "settle") return fail("owner_human_request_invalid");
  const current = await readOwnerHumanCurrent(auth);
  if (!current || current.pointer.lifetimeId !== expectedCurrentLifetimeId) {
    return fail("owner_human_request_current_changed");
  }
  if (!current.pointer.recoveryNeeded) return current;
  const [mission] = await auth.tx.select().from(missions).where(and(
    eq(missions.id, auth.scope.missionId), eq(missions.companyId, auth.scope.companyId)));
  let reason: OwnerHumanCurrent["closure"] extends infer _T ? "source_settled" | "mission_cancelled" | "mission_completed" | null : never = null;
  if (mission?.status === "cancelled") reason = "mission_cancelled";
  else if (mission?.status === "completed") reason = "mission_completed";
  else if (auth.scope.target.kind === "source_issue") {
    const [source] = await auth.tx.select().from(issues).where(and(
      eq(issues.id, auth.scope.target.issueId), eq(issues.companyId, auth.scope.companyId),
      eq(issues.missionId, auth.scope.missionId)));
    if (source && ["done", "cancelled"].includes(source.status)) reason = "source_settled";
  } else if (auth.scope.target.kind === "tool_step") {
    const [step] = await auth.tx.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, auth.scope.target.stepRunId),
      eq(workflowStepRuns.workflowRunId, auth.scope.target.workflowRunId)));
    if (step && ["completed", "cancelled"].includes(step.status)) reason = "source_settled";
  }
  if (!reason) return fail("owner_human_request_recovery_still_needed");
  const eventId = await appendEnd(auth, current.lifetime, reason, null);
  return writePointer(auth, current, { ...current.pointer, revision: current.pointer.revision + 1,
    recoveryNeeded: false, closure: { eventId, reason } }, current.lifetime);
}
