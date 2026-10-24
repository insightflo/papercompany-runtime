import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, issueWorkProducts, issues, missions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { workflowQaRemediationsSchema, workflowVerdictFindingsSchema, type WorkflowVerdictFinding } from "@paperclipai/shared";
import { lockQualityAttemptBudget, reserveQualityRetryUsage } from "../../quality/retry-budget.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import { assertRunNotReplaced } from "../run-replacement-guard.js";
import {
  QaCorrectionReadError, parseQaCorrectionPreparationRow, readQaCorrectionReservation, readQaCorrectionScope,
  readQaCorrectionVerdict, requireQaCorrection, validateQaCorrectionAuthority, type QaCorrectionDb,
} from "./qa-correction-authority.js";
import {
  hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionAppliedKey, qaCorrectionPreparationKey,
  type QaCorrectionPreparation, type QaCorrectionVerdictAuthority,
} from "./qa-correction-contract.js";
import { readIssuedQaCorrection, type IssuedQaCorrection } from "./qa-correction-reader.js";
import { QA_REMEDIATION_MAX_ATTEMPTS, remediationIdempotencyKey } from "./qa-remediation-contract.js";
import { collectQaRemediationEligibility, isInsideBoundary } from "./qa-remediation-qualification.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Handle = { preparationEventId: string; preparationHash: string; preparation: QaCorrectionPreparation };
export type BeginQaCorrectionResult =
  | (Handle & { status: "prepared" | "existing" })
  | (Handle & { status: "already_applied"; appliedEventId: string; proof: IssuedQaCorrection; authority: "history_only" })
  | { status: "waiting" | "not_applicable"; detail: string }
  | { status: "requalification_required"; reason: "qa_subset_already_applied";
      remainingVerdicts: QaCorrectionVerdictAuthority[]; appliedQaStepRunIds: string[] };

// Returning a non-write result must roll back even a newly materialized zero-usage row.
class RollbackResult extends Error {
  constructor(readonly result: BeginQaCorrectionResult) { super("qa_correction_prepare_rollback"); }
}
function stop(result: BeginQaCorrectionResult): never { throw new RollbackResult(result); }
function frozenBody(p: QaCorrectionPreparation) {
  const { correctionId: _id, preparedAt: _at, ...body } = p;
  return hashQaCorrectionPayload(body);
}
async function storedPreparation(db: QaCorrectionDb, candidate: QaCorrectionPreparation): Promise<Handle | null> {
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, candidate.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionPreparationKey(candidate))));
  if (!row) return null;
  const preparation = parseQaCorrectionPreparationRow(row);
  requireQaCorrection(frozenBody(preparation) === frozenBody(candidate), "record");
  return { preparationEventId: row.id, preparationHash: hashQaCorrectionPayload(row.payload), preparation };
}
async function appliedHistory(db: QaCorrectionDb, handle: Handle | null): Promise<BeginQaCorrectionResult | null> {
  if (!handle) return null;
  const p = handle.preparation;
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId), eq(workflowTransitionEvents.workflowRunId, p.workflowRunId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(p.correctionId))));
  if (!row) return null;
  const proof = await readIssuedQaCorrection(db, { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId: row.id });
  requireQaCorrection(hashQaCorrectionPayload(proof.preparation) === handle.preparationHash, "record");
  return { ...handle, status: "already_applied", appliedEventId: row.id, proof, authority: "history_only" };
}

/** Only rows used by current checks. No file IO or generic locking engine. */
async function lockPreparationRows(tx: Tx, p: QaCorrectionPreparation) {
  await tx.select({ id: missions.id }).from(missions).where(and(eq(missions.companyId, p.companyId),
    eq(missions.id, p.missionId))).for("no key update");
  await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, p.companyId),
    eq(workflowRuns.id, p.workflowRunId))).for("no key update");
  const attempts = [p.producer, ...p.authority.verdicts.map(v => v.qa), ...p.bindings.map(b => b.consumer)];
  const heartbeatIds = new Set(p.authority.verdicts.map(v => v.heartbeatRunId));
  for (const source of p.sources) if (source.provenance.kind === "workflow_producer") {
    heartbeatIds.add(source.provenance.workflowProducer.heartbeatRunId);
  }
  if (p.authority.kind === "quality_current_output") {
    heartbeatIds.add(p.authority.source.heartbeatRunId); heartbeatIds.add(p.authority.verifierRunId);
  }
  for (const v of p.authority.verdicts) {
    const [latest] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
      .where(and(eq(heartbeatRuns.issueId, v.qa.issueId), eq(agentWakeupRequests.workflowStepRunId, v.qa.stepRunId)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (latest) heartbeatIds.add(latest.id);
  }
  await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, p.companyId),
    inArray(heartbeatRuns.id, [...heartbeatIds]))).orderBy(asc(heartbeatRuns.id)).for("update");
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, p.companyId),
    inArray(issues.id, attempts.map(a => a.issueId)))).orderBy(asc(issues.id)).for("update");
  await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, p.workflowRunId), inArray(workflowStepRuns.id, attempts.map(a => a.stepRunId))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, p.companyId), inArray(issueWorkProducts.id, p.sources.map(s => s.productId))))
    .orderBy(asc(issueWorkProducts.id)).for("update");
  if (p.bindings.length) await tx.select({ id: workflowStepOutputBindings.id }).from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, p.companyId), eq(workflowStepOutputBindings.workflowRunId, p.workflowRunId),
    inArray(workflowStepOutputBindings.id, p.bindings.map(b => b.bindingId))))
    .orderBy(asc(workflowStepOutputBindings.id)).for("update");
}

async function currentEligibility(tx: Tx, p: QaCorrectionPreparation, existing: Handle | null) {
  await assertRunNotReplaced(tx, p.workflowRunId, p.companyId);
  const reservation = existing ? { preparationEventId: existing.preparationEventId, preparationHash: existing.preparationHash } : undefined;
  const authority = await validateQaCorrectionAuthority(tx, p, { reservation });
  const { run, producer } = await readQaCorrectionScope(tx, p, true);
  const definition = await loadExecutionDefinition(tx, p.workflowRunId, { requireHistorical: false });
  const rejectedQas = [], findingsByQaStepId = new Map<string, WorkflowVerdictFinding[] | null>();
  requireQaCorrection(new Set(p.authority.verdicts.map(v => v.qa.stepRunId)).size === p.authority.verdicts.length, "qualification");
  for (const v of p.authority.verdicts) {
    const fact = await readQaCorrectionVerdict(tx, p, v, true);
    rejectedQas.push({ edge: { stepId: fact.qa.stepId }, qaRun: fact.qa });
    findingsByQaStepId.set(fact.qa.stepId, fact.event.payload.findings === undefined ? null
      : workflowVerdictFindingsSchema.parse(fact.event.payload.findings));
  }
  const eligible = await collectQaRemediationEligibility({
    db: tx, run, steps: definition.steps, producerRun: producer, rejectedQas, findingsByQaStepId,
  }, "prepare");
  if (eligible.status !== "eligible") stop(eligible);
  requireQaCorrection(eligible.qualified.length === p.authority.verdicts.length && eligible.qualified.every(q =>
    p.authority.verdicts.some(v => v.qa.stepRunId === q.qaRun.id && v.eventId === q.sourceVerdictEventId
      && v.heartbeatRunId === q.heartbeatRunId && v.remediationsHash === hashQaCorrectionPayload(q.remediations.items))), "qualification");
  const boundary = { allowedFiles: new Set(authority.sources.map(s => s.file)),
    allowedDirs: authority.sources.map(s => path.dirname(s.file)) };
  requireQaCorrection(eligible.qualified.every(q => q.remediations.items.every(item => isInsideBoundary(item.file, boundary))), "source");
  // Workflow sibling/backedge/recurrent findings and producer loop caps remain the caller's facts.
}

/** Legacy failures spend an attempt, but only an exact structured success consumes a verdict. */
async function checkQaHistory(tx: Tx, p: QaCorrectionPreparation, existing: boolean) {
  const rows = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId), eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    inArray(workflowTransitionEvents.workflowStepRunId, p.authority.verdicts.map(v => v.qa.stepRunId))));
  const preparations = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId), eq(workflowTransitionEvents.workflowRunId, p.workflowRunId),
    eq(workflowTransitionEvents.eventType, "qa_correction_prepared")));
  const validPreparations: QaCorrectionPreparation[] = [];
  for (const row of preparations) {
    try {
      const prepared = parseQaCorrectionPreparationRow(row);
      if (prepared.missionId === p.missionId) validPreparations.push(prepared);
    } catch (error) { if (!(error instanceof QaCorrectionReadError)) throw error; }
  }
  const appliedQaStepRunIds: string[] = [];
  for (const v of p.authority.verdicts) {
    const legacy = rows.filter(row => row.workflowStepRunId === v.qa.stepRunId);
    const succeeded = legacy.some(row => {
      const b = row.payload, items = workflowQaRemediationsSchema.safeParse({ items: b.items });
      return row.workflowRunId === p.workflowRunId && row.missionId === p.missionId && row.issueId === v.qa.issueId && row.heartbeatRunId === v.heartbeatRunId
        && row.layer === "workflow_validation" && row.reason === "workflow_api" && row.verdict === "request_changes"
        && row.idempotencyKey === remediationIdempotencyKey(p.companyId, v.qa.stepRunId, v.eventId)
        && b.kind === "qa_remediation_applied" && b.outcome === "applied"
        && b.producerStepId === p.producer.stepId && b.producerStepRunId === p.producer.stepRunId
        && b.producerIteration === p.producer.iterationIndex && b.qaStepId === v.qa.stepId
        && b.sourceVerdictEventId === v.eventId && typeof b.appliedAt === "string" && Number.isFinite(Date.parse(b.appliedAt))
        && items.success && hashQaCorrectionPayload(items.data.items) === v.remediationsHash;
    });
    if (succeeded) appliedQaStepRunIds.push(v.qa.stepRunId);
  }
  if (appliedQaStepRunIds.length) {
    const remainingVerdicts = p.authority.verdicts.filter(v => !appliedQaStepRunIds.includes(v.qa.stepRunId));
    if (!remainingVerdicts.length) stop({ status: "waiting", detail: "all rejected qa verdicts already remediated; awaiting fresh QA verdict" });
    stop({ status: "requalification_required", reason: "qa_subset_already_applied", remainingVerdicts, appliedQaStepRunIds });
  }
  for (const v of p.authority.verdicts) {
    const legacy = rows.filter(row => row.workflowStepRunId === v.qa.stepRunId).length;
    const prepared = new Set(validPreparations.filter(prep => prep.authority.verdicts.some(q => q.qa.stepRunId === v.qa.stepRunId))
      .map(prep => prep.correctionId)).size;
    if (legacy + prepared + (existing ? 0 : 1) > QA_REMEDIATION_MAX_ATTEMPTS) {
      stop({ status: "not_applicable", detail: "qa " + v.qa.stepId + " remediation attempt cap exhausted" });
    }
  }
}

/**
 * C03/C12 prepare issuance only: reserve once and record before any byte read.
 * History has no current-effect authority; store/CAS/apply/dispatch are subsequent boundaries.
 */
export async function beginQaCorrection(db: Db, candidate: unknown): Promise<BeginQaCorrectionResult> {
  let p: QaCorrectionPreparation;
  try { p = parseQaCorrectionEventPayload("qa_correction_prepared", candidate); }
  catch { throw new QaCorrectionReadError("record"); }
  const history = await appliedHistory(db, await storedPreparation(db, p));
  if (history) return history; // No writing helper, including zero-usage materialization.
  try {
    return await db.transaction(async (tx): Promise<BeginQaCorrectionResult> => {
      const a = p.authority;
      const budget = a.kind === "quality_current_output"
        ? await lockQualityAttemptBudget(tx, { companyId: p.companyId, actionId: a.actionId, now: new Date() }) : undefined;
      await lockPreparationRows(tx, p);
      const existing = await storedPreparation(tx, p);
      const applied = await appliedHistory(tx, existing);
      if (applied) stop(applied);
      const now = new Date(); // Never a caller-controlled deadline check or a pre-lock timestamp.
      const preparation = existing?.preparation ?? { ...p, preparedAt: now.toISOString() };
      await currentEligibility(tx, preparation, existing);
      await checkQaHistory(tx, preparation, existing !== null);
      if (existing) stop({ ...existing, status: "existing" });
      if (a.kind === "quality_current_output") {
        await reserveQualityRetryUsage(tx, { companyId: p.companyId, actionId: a.actionId, now }, budget);
      }
      await tx.insert(workflowTransitionEvents).values({
        id: preparation.correctionId, companyId: preparation.companyId, missionId: preparation.missionId,
        workflowRunId: preparation.workflowRunId, workflowStepRunId: preparation.producer.stepRunId,
        issueId: preparation.producer.issueId, executionGeneration: preparation.producer.executionGeneration,
        eventType: "qa_correction_prepared", layer: "workflow_validation",
        idempotencyKey: qaCorrectionPreparationKey(preparation), payload: preparation, createdAt: now,
      }); // A conflict/error must escape: reservation and INSERT roll back together.
      return { status: "prepared", preparationEventId: preparation.correctionId,
        preparationHash: hashQaCorrectionPayload(preparation), preparation };
    });
  } catch (error) {
    if (error instanceof RollbackResult) return error.result;
    throw error;
  }
}

/** C03/C12: each call owns a fresh transaction; a returned handle never carries locks. */
export async function withCurrentQaCorrectionPreparation<T>(
  db: Db,
  expected: Handle,
  body: (tx: Tx, preparation: Handle) => Promise<{ effect: "write" | "noop"; value: T }>,
): Promise<
  | { status: "current"; effect: "write" | "noop"; value: T }
  | { status: "stopped"; result: BeginQaCorrectionResult }
> {
  let p: QaCorrectionPreparation;
  try { p = parseQaCorrectionEventPayload("qa_correction_prepared", expected.preparation); }
  catch { throw new QaCorrectionReadError("record"); }
  const proof = { preparationEventId: expected.preparationEventId, preparationHash: expected.preparationHash };
  await readQaCorrectionReservation(db, p, proof);
  const history = await appliedHistory(db, { ...proof, preparation: p });
  if (history) return { status: "stopped", result: history };
  const rollback: { noop?: { error: RollbackResult; value: T } } = {};
  try {
    return await db.transaction(async tx => {
      if (p.authority.kind === "quality_current_output") await lockQualityAttemptBudget(tx, {
        companyId: p.companyId, actionId: p.authority.actionId, now: new Date(),
      });
      await lockPreparationRows(tx, p);
      const existing = await storedPreparation(tx, p);
      requireQaCorrection(existing, "record");
      await readQaCorrectionReservation(tx, existing.preparation, proof);
      const applied = await appliedHistory(tx, existing);
      if (applied) stop(applied);
      await currentEligibility(tx, existing.preparation, existing);
      await checkQaHistory(tx, existing.preparation, true);
      const result = await body(tx, existing);
      if (result.effect === "noop") {
        const error = new RollbackResult({ status: "waiting", detail: "qa_correction_noop" });
        rollback.noop = { error, value: result.value };
        throw error;
      }
      return { status: "current" as const, ...result };
    });
  } catch (error) {
    if (rollback.noop && error === rollback.noop.error) {
      return { status: "current", effect: "noop", value: rollback.noop.value };
    }
    if (error instanceof RollbackResult) return { status: "stopped", result: error.result };
    throw error;
  }
}
