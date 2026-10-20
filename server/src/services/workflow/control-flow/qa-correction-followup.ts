import { isDeepStrictEqual } from "node:util";
import { and, count, eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, missions, qualityActions,
  qualityActionGroups, qualityEvidenceRefs, qualityPolicyVersions, workflowRuns, workflowStepRuns,
  workflowStepOutputBindings, workflowTransitionEvents } from "@paperclipai/db";
import { qualityPolicySchema, retryEnvelopeSchema, workflowValidationVerdictValueSchema } from "@paperclipai/shared";
import { hashContract, evidenceContractSchema } from "../../quality/contract.js";
import { readPolicyUsageTotals } from "../../quality/policy-usage.js";
import { captureArtifactRoot, digest, readArtifactBytes } from "../artifact-files.js";
import { assertQaReceiptScope, compareQaCorrectionReceiptFiles, readQaCorrectionToolConsumptionProof } from "../qa-artifact-receipt.js";
import { producerAttemptDetail } from "../../work-products/producer-attempt.js";
import { assertRunNotReplaced } from "../run-replacement-guard.js";
import { hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionFollowupRefSchema,
  qaCorrectionConsumptionSchema, qaCorrectionDeliverySchema, qaCorrectionConsumptionKey, qaCorrectionDeliveryKey,
  type QaCorrectionFollowupRef, type QaCorrectionAttempt } from "./qa-correction-contract.js";
import type { QaCorrectionDb } from "./qa-correction-authority.js";
import type { IssuedQaCorrection } from "./qa-correction-reader.js";
type ReadIssued = (db: QaCorrectionDb, scope: Omit<QaCorrectionFollowupRef, "requestId">) => Promise<IssuedQaCorrection>;
type Revision = IssuedQaCorrection["applied"]["revisions"][number];
type Producer = Extract<IssuedQaCorrection["preparation"]["sources"][number]["provenance"],
  { kind: "workflow_producer" }>["workflowProducer"];
type Event = typeof workflowTransitionEvents.$inferSelect;
export class QaCorrectionFollowupReadError extends Error {
  constructor(readonly reason: string) { super("qa_correction_followup_" + reason); }
}
function requireFollowup(value: unknown, reason: string): asserts value {
  if (!value) throw new QaCorrectionFollowupReadError(reason);
}
const same = isDeepStrictEqual;
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
async function originalProducer(db: QaCorrectionDb, issued: IssuedQaCorrection, revision: Revision,
  readIssued: ReadIssued): Promise<Producer | null> {
  const p = issued.preparation, visited = new Set<string>();
  for (;;) {
    const ancestor = issued.preparation;
    requireFollowup(!visited.has(ancestor.correctionId) && ancestor.companyId === p.companyId
      && ancestor.missionId === p.missionId && ancestor.workflowRunId === p.workflowRunId
      && ancestor.producer.stepRunId === p.producer.stepRunId && ancestor.producer.issueId === p.producer.issueId
      && ancestor.producer.stepId === p.producer.stepId, "lineage");
    visited.add(ancestor.correctionId);
    const source = ancestor.sources.find(s => s.productId === revision.sourceProductId);
    requireFollowup(source, "lineage");
    if (source.provenance.kind === "registered_legacy") return null;
    if (source.provenance.kind === "workflow_producer") return source.provenance.workflowProducer;
    const at = Date.parse(ancestor.preparedAt), productId = source.productId;
    issued = await readIssued(db, { companyId: p.companyId, workflowRunId: p.workflowRunId,
      appliedEventId: source.provenance.appliedEventId });
    const prior = issued.applied.revisions.find(r => r.workProductId === productId);
    requireFollowup(prior && Date.parse(issued.applied.appliedAt) <= at, "lineage");
    revision = prior;
  }
}
/** Historical issuance only. The injected reader validates the real C03 chain, not a key or hint. */
export async function readIssuedQaCorrectionFollowup(db: QaCorrectionDb, value: QaCorrectionFollowupRef, readIssued: ReadIssued) {
  const ref = qaCorrectionFollowupRefSchema.parse(value);
  const issued = await readIssued(db, { companyId: ref.companyId, workflowRunId: ref.workflowRunId, appliedEventId: ref.appliedEventId });
  const matches = issued.followups.filter(f => f.requestId === ref.requestId);
  requireFollowup(matches.length === 1, "request");
  const followup = matches[0]!, rows: Event[] = [];
  for (const id of issued.applied.followupEventIds) {
    const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, id));
    requireFollowup(row, "record");
    if (same(parseQaCorrectionEventPayload("qa_correction_followup_requested", row.payload), followup)) rows.push(row);
  }
  requireFollowup(rows.length === 1 && rows[0]!.companyId === ref.companyId
    && rows[0]!.workflowRunId === ref.workflowRunId && rows[0]!.workflowStepRunId === followup.target.stepRunId
    && rows[0]!.eventType === "qa_correction_followup_requested", "record");
  const revisions = [];
  for (const revisionId of followup.revisionIds) {
    const revision = issued.applied.revisions.find(r => r.revisionId === revisionId);
    requireFollowup(revision, "revision");
    revisions.push({ revision, workflowProducer: await originalProducer(db, issued, revision, readIssued) });
  }
  return { ref, issued, followup, followupEventId: rows[0]!.id, revisions };
}
type Selected = Awaited<ReturnType<typeof readIssuedQaCorrectionFollowup>>;
/** Historical first effect is checked before currentness and again under the owning run lock. */
export async function readQaCorrectionToolReplay(db: QaCorrectionDb, ref: QaCorrectionFollowupRef,
  requestId: string, readIssued: ReadIssued) {
  const relation = await readQaCorrectionFollowupConsumption(db, ref, readIssued);
  if (!relation) return false;
  requireFollowup(relation.consumed.schemaVersion === "workflow.qa-correction.consumption.v2"
    && relation.consumed.evidence.kind === "tool_qa"
    && relation.consumed.evidence.requestId === requestId, "consumption");
  return true;
}
/** A concurrent winner can invalidate the IO snapshot; only its durable matching effect is replayable. */
export async function observeQaCorrectionToolCompletion(db: QaCorrectionDb, ref: QaCorrectionFollowupRef,
  requestId: string, readIssued: ReadIssued) {
  if (await readQaCorrectionToolReplay(db, ref, requestId, readIssued)) return null;
  try { return await observeQaCorrectionFollowup(db, ref, readIssued); }
  catch (error) {
    if (await readQaCorrectionToolReplay(db, ref, requestId, readIssued)) return null;
    throw error;
  }
}

const issuance = (s: Selected) => hashQaCorrectionPayload({ ref: s.ref, preparation: s.issued.preparation,
  applied: s.issued.applied, followup: s.followup, followupEventId: s.followupEventId, revisions: s.revisions });
export type QaCorrectionFollowupObservation = { readonly ref: QaCorrectionFollowupRef };
const observations = new WeakMap<QaCorrectionFollowupObservation, { issuance: string; database: unknown }>();
/** Lock-free IO: compare EVERY registered main/asset/ancillary tuple, without directory discovery. */
export async function observeQaCorrectionFollowup(db: QaCorrectionDb, ref: QaCorrectionFollowupRef, readIssued: ReadIssued) {
  requireFollowup(!is(db, PgTransaction), "transaction");
  const selected = await readQaCorrectionFollowupDb(db, ref, readIssued);
  for (const { revision } of selected.revisions) {
    const root = await captureArtifactRoot(revision.root);
    for (const file of revision.files) {
      const cap = file.role === "main" ? 8 * 1024 * 1024 : file.role === "asset" ? 16 * 1024 * 1024 : 1024 * 1024;
      const bytes = await readArtifactBytes(root, file.relativePath, cap);
      requireFollowup(digest(bytes) === file.sha256 && bytes.length === file.byteSize, "bytes");
    }
    requireFollowup(same(await captureArtifactRoot(root.path), root), "bytes");
  }
  const token = Object.freeze({ ref: Object.freeze({ ...selected.ref }) });
  observations.set(token, { issuance: issuance(selected), database: structuredClone(selected.database) });
  return token;
}
/** Reuse the issued reservation/use. There is no next-slot test, reservation, write or quality lock. */
async function currentQuality(db: QaCorrectionDb, s: Selected) {
  const p = s.issued.preparation, a = p.authority;
  if (a.kind !== "quality_current_output") return null;
  const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.id, a.actionId), eq(qualityActions.companyId, p.companyId)));
  const [group] = await db.select().from(qualityActionGroups).where(and(eq(qualityActionGroups.id, a.groupId), eq(qualityActionGroups.companyId, p.companyId)));
  const [policy] = await db.select().from(qualityPolicyVersions).where(and(eq(qualityPolicyVersions.id, a.policyVersionId), eq(qualityPolicyVersions.companyId, p.companyId)));
  const [use] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, s.issued.applied.qualityUseEvidenceRefId!));
  requireFollowup(action && group && policy && use && use.companyId === p.companyId && use.qualityActionId === action.id
    && action.groupId === group.id && action.policyVersionId === policy.id && group.policyVersionId === policy.id
    && use.status === "verified" && use.reviewItemId === a.reviewItemId && action.intentKey === a.intentKey, "quality");
  const rules = qualityPolicySchema.parse(policy.definition), budget = retryEnvelopeSchema.parse(action.retryEnvelope);
  const evidence = evidenceContractSchema.parse(use.qualityContract), now = new Date();
  requireFollowup(hashContract(budget) === a.retryEnvelopeHash && action.targetHash === a.targetHash
    && action.effectHash === a.effectHash && policy.approvedAt && policy.enabledAt
    && policy.approvedAt <= now && policy.enabledAt <= now && (!policy.disabledAt || policy.disabledAt > now)
    && (!action.cancelRequestedAt || action.cancelRequestedAt > now)
    && now >= new Date(rules.periodStart) && now < new Date(rules.periodEnd) && now < new Date(budget.deadlineAt)
    && (!group.deadlineAt || now < group.deadlineAt) && (!evidence.expiresAt || now < new Date(evidence.expiresAt)), "quality");
  const totals = await readPolicyUsageTotals(db, { companyId: p.companyId, policyVersionId: policy.id,
    windowStart: new Date(rules.periodStart), windowEnd: new Date(rules.periodEnd) });
  const usage = (key: string) => {
    const n = group.usage[key] ?? 0;
    requireFollowup(typeof n === "number" && Number.isSafeInteger(n) && n >= 0, "budget");
    return n;
  };
  const [used] = await db.select({ n: count() }).from(qualityEvidenceRefs).where(and(
    eq(qualityEvidenceRefs.companyId, p.companyId), eq(qualityEvidenceRefs.qualityActionId, action.id),
    sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
  requireFollowup(Number(used?.n) >= 1 && Number(used?.n) <= budget.maxExecutorAttempts
    && totals.executionAttempts <= budget.maxExecutorAttempts && usage("executionAttempts") <= budget.maxExecutorAttempts
    && totals.reservedCostCents + totals.chargedCostCents <= rules.maxCostCentsPerPeriod
    && usage("reservedCostCents") + usage("chargedCostCents") <= budget.maxCumulativeCostCents, "budget");
  return { action, group, policy, use, totals };
}
async function currentAttempt(db: QaCorrectionDb, s: Selected, attempt: QaCorrectionAttempt) {
  const p = s.issued.preparation;
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, attempt.stepRunId),
    eq(workflowStepRuns.workflowRunId, p.workflowRunId)));
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, attempt.issueId), eq(issues.companyId, p.companyId)));
  requireFollowup(step && issue && issue.missionId === p.missionId && !issue.hiddenAt && issue.status !== "cancelled"
    && step.stepId === attempt.stepId && step.issueId === issue.id && step.executionGeneration === attempt.executionGeneration
    && step.retryCount === attempt.retryCount && step.iterationIndex === attempt.iterationIndex
    && step.status !== "cancelled", "attempt");
  return { step, issue };
}

/** SELECT-only currentness. Writers own quality→mission→run→heartbeat→issue→sorted steps→products→bindings.
 * Never add that prefix after a terminal run lock. Read errors propagate. */
export async function readQaCorrectionFollowupDb(db: QaCorrectionDb, ref: QaCorrectionFollowupRef, readIssued: ReadIssued) {
  const s = await readIssuedQaCorrectionFollowup(db, ref, readIssued), p = s.issued.preparation;
  await assertRunNotReplaced(db, p.workflowRunId, p.companyId);
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, p.workflowRunId), eq(workflowRuns.companyId, p.companyId)));
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, p.missionId), eq(missions.companyId, p.companyId)));
  requireFollowup(run && mission && run.missionId === mission.id && run.dispatchAuthorityVersion === p.dispatchAuthorityVersion
    && !["completed", "cancelled", "aborted", "failed", "timed-out"].includes(run.status)
    && !["completed", "cancelled"].includes(mission.status), "stale");
  const target = await currentAttempt(db, s, s.followup.target), producer = await currentAttempt(db, s, p.producer);
  requireFollowup(producer.step.status === "completed" && producer.step.completedAt, "attempt");
  const products = [], bindings = [];
  for (const { revision } of s.revisions) {
    const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, revision.workProductId));
    requireFollowup(product && product.companyId === p.companyId && product.issueId === p.producer.issueId
      && product.status === "active" && object(product.metadata?.qaCorrection).appliedEventId === s.ref.appliedEventId
      && object(product.metadata?.qaCorrection).revisionId === revision.revisionId, "revision");
    products.push(product);
  }
  for (const change of s.issued.applied.bindingChanges) {
    const expected = p.bindings.find(b => b.bindingId === change.bindingId)!;
    const [found] = await db.select({ row: workflowStepOutputBindings, resolvedAt: sql<string>`${workflowStepOutputBindings.resolvedAt}::text` })
      .from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, change.bindingId));
    const binding = found?.row;
    requireFollowup(binding && binding.companyId === p.companyId && binding.workflowRunId === p.workflowRunId
      && binding.consumerStepRunId === expected.consumer.stepRunId && binding.referencedStepId === expected.referencedStepId
      && binding.workProductId === change.toProductId && (binding.sourceExecutionGeneration === null
        || binding.sourceExecutionGeneration === p.producer.executionGeneration), "binding");
    bindings.push(found);
  }
  return { ...s, status: "db_current_only" as const,
    database: { run, mission, target, producer, products, bindings, quality: await currentQuality(db, s) } };
}
/** Same-transaction issuance + DB snapshot comparison against the unforgeable lock-free IO token. */
export async function readCurrentQaCorrectionFollowup(db: QaCorrectionDb, ref: QaCorrectionFollowupRef,
  observation: QaCorrectionFollowupObservation, readIssued: ReadIssued) {
  requireFollowup(is(db, PgTransaction), "transaction");
  const captured = observations.get(observation);
  requireFollowup(captured, "observation");
  const current = await readQaCorrectionFollowupDb(db, ref, readIssued);
  requireFollowup(same(observation.ref, current.ref) && captured.issuance === issuance(current)
    && same(captured.database, current.database), "observation");
  return { ...current, status: "rechecked_only" as const };
}
function receiptRow(row: Event | undefined, s: Selected, type: string, key: string): asserts row is Event {
  const p = s.issued.preparation, t = s.followup.target;
  requireFollowup(row && row.companyId === p.companyId && row.missionId === p.missionId
    && row.workflowRunId === p.workflowRunId && row.workflowStepRunId === t.stepRunId && row.issueId === t.issueId
    && row.executionGeneration === t.executionGeneration && row.layer === "workflow_validation"
    && row.eventType === type && row.idempotencyKey === key, "consumption");
}
/** Stored relation ONLY, including finished heartbeats. This is neither bytes nor fresh execution authority. */
export async function readQaCorrectionFollowupConsumption(db: QaCorrectionDb, ref: QaCorrectionFollowupRef, readIssued: ReadIssued) {
  const s = await readIssuedQaCorrectionFollowup(db, ref, readIssued), p = s.issued.preparation, t = s.followup.target;
  const [row] = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, p.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionConsumptionKey(s.ref.requestId))));
  if (!row) return null;
  receiptRow(row, s, "qa_correction_followup_consumed", qaCorrectionConsumptionKey(s.ref.requestId));
  const consumed = qaCorrectionConsumptionSchema.parse(row.payload);
  requireFollowup(same(consumed.ref, s.ref) && consumed.followupEventId === s.followupEventId
    && same(consumed.followup, s.followup) && row.createdAt.getTime() === Date.parse(consumed.consumedAt), "consumption");
  requireFollowup(Date.parse(s.issued.applied.appliedAt) <= row.createdAt.getTime(), "consumption");
  const evidence = consumed.evidence;
  if (evidence.kind === "workflow_verdict") {
    const [deliveredRow] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, evidence.deliveryEventId));
    receiptRow(deliveredRow, s, "qa_correction_followup_delivered", qaCorrectionDeliveryKey(s.ref.requestId));
    const delivered = qaCorrectionDeliverySchema.parse(deliveredRow.payload);
    requireFollowup(same(delivered.ref, s.ref) && delivered.followupEventId === s.followupEventId
      && deliveredRow.createdAt.getTime() === Date.parse(delivered.deliveredAt)
      && Date.parse(p.preparedAt) <= Date.parse(delivered.deliveredAt)
      && Date.parse(s.issued.applied.appliedAt) <= Date.parse(delivered.deliveredAt)
      && Date.parse(delivered.deliveredAt) <= Date.parse(consumed.consumedAt), "consumption");
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.heartbeatRunId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.wakeupRequestId));
    requireFollowup(heartbeat && wake && heartbeat.companyId === p.companyId && wake.companyId === p.companyId
      && heartbeat.agentId === wake.agentId && heartbeat.issueId === t.issueId && wake.issueId === t.issueId
      && wake.missionId === p.missionId && wake.workflowRunId === p.workflowRunId && wake.workflowStepRunId === t.stepRunId
      && wake.workflowExecutionGeneration === t.executionGeneration && heartbeat.workflowStepRunId === t.stepRunId
      && heartbeat.workflowExecutionGeneration === t.executionGeneration && heartbeat.wakeupRequestId === wake.id
      && wake.runId === heartbeat.id && same(object(wake.payload).qaCorrectionFollowup, s.ref)
      && deliveredRow.heartbeatRunId === heartbeat.id && deliveredRow.wakeupRequestId === wake.id
      && (consumed.schemaVersion !== "workflow.qa-correction.consumption.v1"
        || row.heartbeatRunId === heartbeat.id && row.wakeupRequestId === wake.id), "consumption");
    const [verdict] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, evidence.eventId));
    requireFollowup(verdict && verdict.companyId === p.companyId && verdict.missionId === p.missionId
      && verdict.workflowRunId === p.workflowRunId && verdict.workflowStepRunId === t.stepRunId && verdict.issueId === t.issueId
      && (consumed.schemaVersion !== "workflow.qa-correction.consumption.v1"
        || verdict.heartbeatRunId === heartbeat.id && (verdict.wakeupRequestId === null || verdict.wakeupRequestId === wake.id))
      && verdict.eventType === "workflow_validation_verdict"
      && verdict.layer === "workflow_validation" && verdict.reason === "workflow_api"
      && (verdict.executionGeneration === null || verdict.executionGeneration === t.executionGeneration)
      && workflowValidationVerdictValueSchema.safeParse(verdict.verdict).success
      && verdict.payload.kind === "workflow_validation_verdict" && verdict.payload.workflowRunId === p.workflowRunId
      && verdict.payload.stepRunId === t.stepRunId && verdict.payload.issueId === t.issueId && verdict.payload.verdict === verdict.verdict
      && verdict.createdAt >= deliveredRow.createdAt && verdict.createdAt <= row.createdAt, "consumption");
    if (consumed.schemaVersion === "workflow.qa-correction.consumption.v2") {
      requireFollowup(verdict.heartbeatRunId, "consumption");
      const [actor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
      requireFollowup(actor && row.heartbeatRunId === actor.id && row.wakeupRequestId === actor.wakeupRequestId
        && (verdict.wakeupRequestId === null || verdict.wakeupRequestId === actor.wakeupRequestId), "consumption");
      const detail = await producerAttemptDetail(db, actor, {
        id: t.stepRunId, workflowRunId: p.workflowRunId, stepId: t.stepId, issueId: t.issueId,
        executionGeneration: t.executionGeneration, retryCount: t.retryCount, iterationIndex: t.iterationIndex,
      });
      requireFollowup(detail.rootHeartbeatRunId === heartbeat.id && detail.rootWakeupRequestId === wake.id, "consumption");
    }
  } else if (consumed.schemaVersion === "workflow.qa-correction.consumption.v2" && consumed.evidence.kind === "tool_qa") {
    const evidence = consumed.evidence;
    const { proof } = await readQaCorrectionToolConsumptionProof(db, { ref: s.ref,
      proofEventId: evidence.proofEventId, stepRunId: evidence.stepRunId, requestId: evidence.requestId, sha256: evidence.sha256 });
    requireFollowup(row.heartbeatRunId === null && row.wakeupRequestId === null
      && Date.parse(proof.completedAt) <= Date.parse(consumed.consumedAt)
      && proof.followupEventId === s.followupEventId, "consumption");
  } else {
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, evidence.stepRunId));
    requireFollowup(step && step.id === t.stepRunId && step.workflowRunId === p.workflowRunId
      && row.heartbeatRunId === null && row.wakeupRequestId === null
      && step.status === "completed" && step.completedAt && step.completedAt >= new Date(s.issued.applied.appliedAt)
      && step.completedAt <= row.createdAt, "consumption");
    const receipt = assertQaReceiptScope(step.metadata.toolArtifactReceipt,
      { run: { id: p.workflowRunId, companyId: p.companyId, missionId: p.missionId }, stepRun: step }, evidence.requestId);
    requireFollowup(s.revisions.length === 1, "consumption");
    const revision = s.revisions.find(r => r.revision.workProductId === receipt.input.workProductId);
    const mismatch = revision ? compareQaCorrectionReceiptFiles(revision.revision, receipt.input) : "input";
    requireFollowup(receipt.sha256 === evidence.sha256 && receipt.executionGeneration === t.executionGeneration
      && receipt.retryCount === t.retryCount && receipt.iterationIndex === t.iterationIndex
      && same(object(step.metadata.toolArtifactRequest).qaCorrectionFollowup, s.ref) && revision && mismatch !== "input"
      && revision.workflowProducer && same(receipt.input.producer, revision.workflowProducer), "consumption");
    requireFollowup(mismatch === null, "consumption");
  }
  return { status: "db_consumption_relation_only" as const, consumed, eventId: row.id };
}
