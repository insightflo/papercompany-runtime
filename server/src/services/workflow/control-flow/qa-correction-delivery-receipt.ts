import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { conflict } from "../../../errors.js";
import { readAdmittedWorkflowIdentity } from "../../heartbeat-finalization/producer-identity.js";
import { readWorkflowAttemptProof, withoutWorkflowAttemptProof } from "../../heartbeat-finalization/workflow-attempt-proof.js";
import { QA_CORRECTION_WAKE_PREFIX, qaCorrectionWakeKey, readQaCorrectionWakeRef } from "../../work-products/qa-correction-producer-attempt.js";
import { qaCorrectionDeliveryKey, qaCorrectionDeliverySchema, qaCorrectionFollowupRefSchema,
  type QaCorrectionFollowupRef } from "./qa-correction-contract.js";
import { readIssuedQaCorrectionFollowupForAttempt } from "./qa-correction-reader.js";

export type DeliveryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DeliveryWake = typeof agentWakeupRequests.$inferSelect;
export type DeliveryHistory = Awaited<ReturnType<typeof readIssuedQaCorrectionFollowupForAttempt>>;
export type CorrectionDeliveryInput = {
  mode: "initial" | "queued" | "deferred";
  ref: QaCorrectionFollowupRef;
  companyId: string; agentId: string; issueId: string; missionId: string;
  workflowRunId: string; workflowStepRunId: string; workflowExecutionGeneration: number;
  candidateWakeupRequestId: string | null;
  request: {
    idempotencyKey: string; source: string; triggerDetail: string | null; reason: string | null;
    requestKind: string | null; requestedByActorType: string | null; requestedByActorId: string | null;
    payload: Record<string, unknown> | null; contextSnapshot: Record<string, unknown>;
  };
};
export type CorrectionDeliveryResult =
  | { kind: "waiting"; wakeupRequestId: string; startRunId: null }
  | { kind: "new_delivery"; wakeupRequestId: string; heartbeatRunId: string; deliveryEventId: string; startRunId: string }
  | { kind: "existing_receipt"; wakeupRequestId: string; heartbeatRunId: string; deliveryEventId: string; startRunId: null };

export function requireDelivery(value: unknown, reason: string): asserts value {
  if (!value) throw conflict("qa_correction_delivery_" + reason);
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const contextKey = "_paperclipWakeContext";

/** Validate the actual incoming ref/key. A caller's proof is removed only by the existing server writer. */
export function assertDeliveryInput(input: CorrectionDeliveryInput) {
  const ref = qaCorrectionFollowupRefSchema.parse(input.ref), r = input.request;
  requireDelivery(["initial", "queued", "deferred"].includes(input.mode)
    && ref.companyId === input.companyId && ref.workflowRunId === input.workflowRunId
    && r.idempotencyKey.startsWith(QA_CORRECTION_WAKE_PREFIX) && r.idempotencyKey === qaCorrectionWakeKey(ref)
    && same(qaCorrectionFollowupRefSchema.parse(r.payload?.qaCorrectionFollowup), ref)
    && (input.mode === "initial" || !!input.candidateWakeupRequestId), "input");
  requireDelivery(!Object.hasOwn(r.payload ?? {}, contextKey), "reserved_context");
  for (const [key, expected] of Object.entries({ issueId: input.issueId, missionId: input.missionId,
    workflowRunId: input.workflowRunId, workflowStepRunId: input.workflowStepRunId })) {
    requireDelivery(!Object.hasOwn(r.payload ?? {}, key) || r.payload?.[key] === expected, "scope");
    requireDelivery(r.contextSnapshot[key] === expected, "context");
  }
  requireDelivery(r.contextSnapshot.wakeReason === r.reason, "context");
}

/** Logical scope and actual agent remain mandatory for history; mutable counters and policy do not. */
export async function assertDeliveryScope(db: Pick<Db, "select">, input: CorrectionDeliveryInput, h: DeliveryHistory) {
  const p = h.issued.preparation, t = h.followup.target;
  requireDelivery(same(h.ref, input.ref) && p.companyId === input.companyId && p.missionId === input.missionId
    && p.workflowRunId === input.workflowRunId && t.stepRunId === input.workflowStepRunId
    && t.issueId === input.issueId && h.followup.appliedEventId === input.ref.appliedEventId
    && h.followup.requestId === input.ref.requestId
    && same(h.revisions.map(r => r.revision.revisionId), h.followup.revisionIds), "scope");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, t.issueId), eq(issues.companyId, input.companyId)));
  const authority = p.authority.verdicts.find(v => same(v.qa, t));
  const [origin] = authority ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, authority.heartbeatRunId)) : [];
  requireDelivery(agent && issue && issue.missionId === input.missionId
    && (issue.assigneeAgentId ? issue.assigneeAgentId === agent.id : origin?.agentId === agent.id), "agent");
  return { agent, issue };
}

/** The narrow deferred reason exception never normalizes caller fields or malformed saved context. */
export function assertDeliverySignature(input: CorrectionDeliveryInput, wake: DeliveryWake, historical: boolean) {
  const r = input.request, clean = withoutWorkflowAttemptProof(wake.payload) ?? {};
  const caller = withoutWorkflowAttemptProof(r.payload) ?? {}, savedContext = clean[contextKey];
  requireDelivery(Object.hasOwn(clean, contextKey) && record(savedContext)
    && same(savedContext, withoutWorkflowAttemptProof({
      [contextKey]: r.contextSnapshot })?.[contextKey]), "context");
  let reason = wake.reason;
  const deferred = !historical && wake.status === "deferred_issue_execution" && wake.runId === null
    && reason === "issue_execution_deferred";
  const promoted = historical && reason === "issue_execution_promoted";
  if (deferred || promoted) {
    requireDelivery(Object.hasOwn(savedContext, "wakeReason"), "context");
    reason = savedContext.wakeReason as string | null;
  }
  delete clean[contextKey];
  // The server duplicates issueId only after the typed scope has been proven.
  if (!Object.hasOwn(caller, "issueId") && Object.hasOwn(clean, "issueId")) {
    requireDelivery(clean.issueId === input.issueId && wake.issueId === input.issueId, "scope");
    delete clean.issueId;
  }
  requireDelivery(wake.source === r.source && wake.triggerDetail === r.triggerDetail && reason === r.reason
    && wake.requestKind === r.requestKind && wake.requestedByActorType === r.requestedByActorType
    && wake.requestedByActorId === r.requestedByActorId && wake.idempotencyKey === r.idempotencyKey
    && same(clean, caller), "signature");
}

/** Real original server proof and PostgreSQL timestamp precision; no current step-counter inference. */
export async function assertDeliveryWake(db: Pick<Db, "select">, input: CorrectionDeliveryInput,
  h: DeliveryHistory, wake: DeliveryWake) {
  const t = h.followup.target, proof = readWorkflowAttemptProof(wake);
  requireDelivery(same(readQaCorrectionWakeRef(wake), h.ref) && wake.companyId === input.companyId
    && wake.agentId === input.agentId && wake.issueId === t.issueId && wake.missionId === input.missionId
    && wake.workflowRunId === input.workflowRunId && wake.workflowStepRunId === t.stepRunId
    && wake.workflowExecutionGeneration === t.executionGeneration && wake.status !== "coalesced"
    && proof.parentHeartbeatRunId === null && proof.retryCount === t.retryCount
    && proof.iterationIndex === t.iterationIndex && proof.executionGeneration === t.executionGeneration, "proof");
  const [ordered] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, wake.id))
    .where(and(eq(workflowTransitionEvents.id, h.followupEventId),
      eq(workflowTransitionEvents.companyId, input.companyId), eq(workflowTransitionEvents.workflowRunId, input.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_correction_followup_requested"),
      lte(workflowTransitionEvents.createdAt, agentWakeupRequests.requestedAt)));
  requireDelivery(ordered, "time");
}

export async function readDeliveryWakeCandidates(db: Pick<Db, "select">, i: CorrectionDeliveryInput) {
  return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, i.companyId),
    or(eq(agentWakeupRequests.idempotencyKey, i.request.idempotencyKey),
      sql`${agentWakeupRequests.payload}->'qaCorrectionFollowup'->>'requestId' = ${i.ref.requestId}`,
      i.candidateWakeupRequestId ? eq(agentWakeupRequests.id, i.candidateWakeupRequestId) : sql`false`)))
    .orderBy(asc(agentWakeupRequests.id));
}
export async function findDeliveryEvent(db: Pick<Db, "select">, input: CorrectionDeliveryInput) {
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionDeliveryKey(input.ref.requestId))));
  return row ?? null;
}

/** Root owns the RR READ ONLY snapshot. This reader never opens a transaction or grants another start. */
export async function readQaCorrectionDelivery(db: Pick<Db, "select">, input: CorrectionDeliveryInput) {
  const row = await findDeliveryEvent(db, input);
  if (!row) return null;
  const h = await readIssuedQaCorrectionFollowupForAttempt(db, input.ref), t = h.followup.target;
  await assertDeliveryScope(db, input, h);
  const d = qaCorrectionDeliverySchema.parse(row.payload);
  requireDelivery(row.companyId === input.companyId && row.missionId === input.missionId
    && row.workflowRunId === input.workflowRunId && row.workflowStepRunId === t.stepRunId
    && row.issueId === t.issueId && row.executionGeneration === t.executionGeneration
    && row.eventType === "qa_correction_followup_delivered" && row.layer === "workflow_validation"
    && same(d.ref, h.ref) && d.followupEventId === h.followupEventId
    && row.wakeupRequestId === d.wakeupRequestId && row.heartbeatRunId === d.heartbeatRunId, "receipt");
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, d.wakeupRequestId));
  const heartbeats = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, d.wakeupRequestId));
  const heartbeat = heartbeats[0], candidates = await readDeliveryWakeCandidates(db, input);
  requireDelivery(heartbeats.length === 1 && heartbeat?.id === d.heartbeatRunId
    && candidates.length === 1 && candidates[0]!.id === d.wakeupRequestId, "relation");
  requireDelivery(wake && heartbeat && wake.runId === heartbeat.id && heartbeat.wakeupRequestId === wake.id
    && heartbeat.companyId === input.companyId && heartbeat.agentId === input.agentId && heartbeat.issueId === t.issueId
    && heartbeat.workflowStepRunId === t.stepRunId && heartbeat.workflowExecutionGeneration === t.executionGeneration
    && heartbeat.retryOfRunId === null && !["skipped", "coalesced", "deferred_issue_execution"].includes(wake.status), "relation");
  if (input.candidateWakeupRequestId) requireDelivery(input.candidateWakeupRequestId === wake.id, "candidate");
  await assertDeliveryWake(db, input, h, wake);
  // Only after the full receipt relation is established may promoted reason use the saved original context.
  assertDeliverySignature(input, wake, true);
  const [ordered] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, wake.id))
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeat.id))
    .where(and(eq(workflowTransitionEvents.id, row.id),
      sql`${workflowTransitionEvents.createdAt} = ${d.deliveredAt}::timestamptz`,
      lte(agentWakeupRequests.requestedAt, workflowTransitionEvents.createdAt),
      lte(heartbeatRuns.createdAt, workflowTransitionEvents.createdAt)));
  requireDelivery(ordered && Date.parse(h.issued.preparation.preparedAt) <= Date.parse(d.deliveredAt)
    && Date.parse(h.issued.applied.appliedAt) <= Date.parse(d.deliveredAt), "time");
  return { kind: "existing_receipt" as const, wakeupRequestId: wake.id,
    heartbeatRunId: heartbeat.id, deliveryEventId: row.id, startRunId: null };
}

/** Called only after the root has verified and persisted the real queued heartbeat's identity. */
export async function insertCorrectionDelivery(tx: DeliveryTx, input: CorrectionDeliveryInput,
  h: DeliveryHistory, wake: DeliveryWake, heartbeatRunId: string) {
  const now = new Date(), t = h.followup.target;
  const payload = qaCorrectionDeliverySchema.parse({ schemaVersion: "workflow.qa-correction.delivery.v1",
    ref: h.ref, followupEventId: h.followupEventId, wakeupRequestId: wake.id, heartbeatRunId,
    deliveredAt: now.toISOString() });
  const [row] = await tx.insert(workflowTransitionEvents).values({
    companyId: input.companyId, missionId: input.missionId, workflowRunId: input.workflowRunId,
    workflowStepRunId: t.stepRunId, issueId: t.issueId, executionGeneration: t.executionGeneration,
    wakeupRequestId: wake.id, heartbeatRunId, eventType: "qa_correction_followup_delivered",
    layer: "workflow_validation", idempotencyKey: qaCorrectionDeliveryKey(input.ref.requestId), payload, createdAt: now,
  }).returning();
  requireDelivery(row, "insert");
  return { kind: "new_delivery" as const, wakeupRequestId: wake.id, heartbeatRunId,
    deliveryEventId: row.id, startRunId: heartbeatRunId };
}

/** The real writer leaves NULL identity. Persist exactly these two fields without claiming the run. */
export async function persistDeliveryIdentity(tx: DeliveryTx, i: CorrectionDeliveryInput,
  h: DeliveryHistory, before: DeliveryWake) {
  const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, before.id));
  requireDelivery(wake && wake.runId && wake.status === "queued", "writer_link");
  requireDelivery(same(wake.payload, before.payload) && wake.companyId === before.companyId
    && wake.agentId === before.agentId && wake.source === before.source && wake.triggerDetail === before.triggerDetail
    && wake.requestKind === before.requestKind && wake.requestedByActorId === before.requestedByActorId
    && wake.requestedByActorType === before.requestedByActorType
    && wake.idempotencyKey === before.idempotencyKey && wake.requestedAt.getTime() === before.requestedAt.getTime()
    && (wake.reason === before.reason || (before.status === "deferred_issue_execution"
      && before.reason === "issue_execution_deferred" && wake.reason === "issue_execution_promoted")), "writer_signature");
  await assertDeliveryWake(tx, i, h, wake);
  const rows = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
  const heartbeat = rows[0], t = h.followup.target;
  requireDelivery(rows.length === 1 && heartbeat && heartbeat.id === wake.runId
    && heartbeat.companyId === i.companyId && heartbeat.agentId === i.agentId
    && heartbeat.issueId === i.issueId && heartbeat.status === "queued" && heartbeat.retryOfRunId === null, "writer_link");
  requireDelivery((heartbeat.workflowStepRunId === null) === (heartbeat.workflowExecutionGeneration === null), "identity");
  const identity = await readAdmittedWorkflowIdentity(tx as unknown as Db, heartbeat);
  requireDelivery(identity && identity.workflowRunId === i.workflowRunId && identity.missionId === i.missionId
    && identity.workflowStepRunId === t.stepRunId && identity.workflowExecutionGeneration === t.executionGeneration, "identity");
  if (heartbeat.workflowStepRunId === null) {
    const written = await tx.update(heartbeatRuns).set({
      workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration,
    }).where(and(eq(heartbeatRuns.id, heartbeat.id), eq(heartbeatRuns.companyId, i.companyId),
      eq(heartbeatRuns.wakeupRequestId, wake.id), eq(heartbeatRuns.status, "queued"),
      isNull(heartbeatRuns.workflowStepRunId), isNull(heartbeatRuns.workflowExecutionGeneration))).returning({ id: heartbeatRuns.id });
    requireDelivery(written.length === 1, "identity");
  } else requireDelivery(heartbeat.workflowStepRunId === t.stepRunId
    && heartbeat.workflowExecutionGeneration === t.executionGeneration, "identity");
  const [actual] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.id));
  const [actualWake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
  requireDelivery(actual && actualWake && same(actualWake, wake) && same(actual, {
    ...heartbeat, workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration,
  }), "identity_write");
  await assertDeliveryWake(tx, i, h, actualWake);
  return { wake: actualWake, heartbeat: actual };
}
