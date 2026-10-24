import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, workflowStepRuns,
  workflowStepOutputBindings, workflowTransitionEvents } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { qaCorrectionConsumptionSchema, qaCorrectionConsumptionKey } from "./control-flow/qa-correction-contract.js";
import { readQaCorrectionFollowupConsumption, type readIssuedQaCorrectionFollowup } from "./control-flow/qa-correction-followup.js";
import type { IssuedQaCorrection } from "./control-flow/qa-correction-reader.js";
import { workflowQaRemediationsSchema, workflowVerdictFindingsSchema } from "@paperclipai/shared";
import type {
  WorkflowNonblockingAcceptance,
  WorkflowQaRemediations,
  WorkflowValidationVerdictPayload,
  WorkflowValidationVerdictValue,
  WorkflowVerdictFinding,
} from "@paperclipai/shared";
import type { WorkflowValidationLedgerResult } from "./validation-verdict-ledger.js";

type ResolveContext = typeof import("./validation-verdict-ledger.js").resolveWorkflowValidationContext;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Parameters<ResolveContext>[1];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Selected = Awaited<ReturnType<typeof readIssuedQaCorrectionFollowup>>;
type Run = typeof heartbeatRuns.$inferSelect;
type CorrectionWrite = { selected: Selected; actor: Run; deliveryEventId: string };
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const requireWrite = (ok: unknown) => { if (!ok) throw conflict("qa_correction_verdict_relation_changed"); };
const identity = (r: Run) => [r.id, r.companyId, r.agentId, r.issueId, r.wakeupRequestId,
  r.retryOfRunId, r.workflowStepRunId, r.workflowExecutionGeneration, r.startedAt];
const owner = (r: typeof issues.$inferSelect) => [r.id, r.executionRunId, r.checkoutRunId,
  r.executionAgentNameKey, r.executionLockedAt];

export class WorkflowVerdictConsumptionConflict extends Error {}

async function dependencyHeartbeats(db: Pick<Db, "select">, companyId: string,
  rows: (typeof issues.$inferSelect)[], heartbeatIds: string[]) {
  const ids = sorted([...heartbeatIds, ...rows.flatMap(r => [r.executionRunId, r.checkoutRunId])]
    .filter((id): id is string => !!id));
  const found = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
    or(inArray(heartbeatRuns.issueId, rows.map(r => r.id)), inArray(heartbeatRuns.id, ids))));
  const all = new Map(found.map(r => [r.id, r]));
  requireWrite(ids.every(id => all.has(id)));
  for (const row of all.values()) {
    if (!row.retryOfRunId || all.has(row.retryOfRunId)) continue;
    const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.retryOfRunId));
    requireWrite(parent && parent.companyId === companyId);
    all.set(parent!.id, parent!);
  }
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Discover the complete history/owner/technical-parent set before acquiring any ordered locks. */
export async function prepareWorkflowVerdictLocks(db: Db, h: Selected, chain: Run[]) {
  const readIssued = createQaCorrectionHistorySession(db, h.ref);
  const history = new Map<string, IssuedQaCorrection>([[h.issued.preparation.correctionId, h.issued]]);
  for (const issued of history.values()) {
    for (const source of issued.preparation.sources) {
      if (source.provenance.kind !== "prior_correction") continue;
      const prior = await readIssued(db, { ...h.ref, appliedEventId: source.provenance.appliedEventId });
      requireWrite(prior.preparation.missionId === h.issued.preparation.missionId);
      history.set(prior.preparation.correctionId, prior);
    }
  }
  const all = [...history.values()], preparations = all.map(s => s.preparation);
  const targets = [h.followup.target, ...preparations.flatMap(p => [p.producer,
    ...p.authority.verdicts.map(v => v.qa), ...p.bindings.map(b => b.consumer)])];
  const products = sorted(all.flatMap(s => [...s.preparation.sources.map(p => p.productId),
    ...s.applied.revisions.map(r => r.workProductId)]));
  const bindings = sorted(preparations.flatMap(p => p.bindings.map(b => b.bindingId)));
  const heartbeatIds = sorted([...chain.map(r => r.id), ...preparations.flatMap(p => [
    ...p.authority.verdicts.map(v => v.heartbeatRunId),
    ...p.sources.flatMap(s => s.provenance.kind === "workflow_producer" ? [s.provenance.workflowProducer.heartbeatRunId] : []),
    ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : []),
  ])]);
  const issueIds = sorted(targets.map(t => t.issueId));
  const rows = await db.select().from(issues).where(and(eq(issues.companyId, h.ref.companyId),
    inArray(issues.id, issueIds))).orderBy(asc(issues.id));
  requireWrite(rows.length === issueIds.length);
  const observed = await dependencyHeartbeats(db, h.ref.companyId, rows, heartbeatIds);
  const wakeIds = sorted(observed.flatMap(r => r.wakeupRequestId ? [r.wakeupRequestId] : []));
  const wakes = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds))
    .orderBy(asc(agentWakeupRequests.id));
  requireWrite(wakes.length === wakeIds.length);
  return { h, targets, products, bindings, heartbeatIds, rows, observed, wakes };
}
type Dependencies = Awaited<ReturnType<typeof prepareWorkflowVerdictLocks>>;

/** Caller already owns quality→mission→run. A changed owner/parent set rolls back instead of taking late HB locks. */
export async function lockWorkflowVerdictDependencies(tx: Tx, o: Dependencies) {
  const companyId = o.h.ref.companyId;
  await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.id, o.observed.map(r => r.id)))).orderBy(asc(heartbeatRuns.id)).for("update");
  const rows = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
    inArray(issues.id, o.rows.map(r => r.id)))).orderBy(asc(issues.id)).for("update");
  const observed = await dependencyHeartbeats(tx, companyId, rows, o.heartbeatIds);
  requireWrite(same(rows.map(owner), o.rows.map(owner)) && same(observed.map(identity), o.observed.map(identity)));
  await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, o.h.ref.workflowRunId),
    inArray(workflowStepRuns.id, sorted(o.targets.map(t => t.stepRunId)))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId),
    inArray(issueWorkProducts.id, o.products))).orderBy(asc(issueWorkProducts.id)).for("update");
  await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, companyId),
    eq(workflowStepOutputBindings.workflowRunId, o.h.ref.workflowRunId),
    inArray(workflowStepOutputBindings.id, o.bindings))).orderBy(asc(workflowStepOutputBindings.id)).for("update");
  const wakes = await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, o.wakes.map(w => w.id)))
    .orderBy(asc(agentWakeupRequests.id)).for("update");
  requireWrite(same(wakes, o.wakes));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export async function recordWorkflowValidationVerdict(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly verdict: WorkflowValidationVerdictValue;
  readonly source: "workflow_api";
  readonly actorAgentId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly sourceText?: string | null;
  readonly nonblockingAcceptance?: WorkflowNonblockingAcceptance | null;
  readonly findings?: readonly WorkflowVerdictFinding[] | null;
  readonly remediations?: WorkflowQaRemediations | null;
}, resolveWorkflowValidationContext: ResolveContext, correction?: CorrectionWrite): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue, { mode: "record" });
  if (!context.isCandidate || !context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null, insufficientEvidence: false, insufficientEvidenceReason: null };
  }
  if (correction) {
    requireWrite(context.workflowRunId === correction.selected.ref.workflowRunId
      && context.workflowStepRunId === correction.selected.followup.target.stepRunId
      && input.heartbeatRunId === correction.actor.id);
  }
  // [qa-cap acceptance] nonblocking 분류는 request_changes verdict 와만 공존. heartbeat/comment 경로는
  //   이 필드를 넘기지 않으므로 구조적 수용은 오직 공식 workflow API(request_changes) 만 가능하다.
  const acceptance = input.nonblockingAcceptance && input.verdict === "request_changes"
    ? input.nonblockingAcceptance
    : null;
  // [qa defect layer] findings 도 nonblockingAcceptance 와 동일하게 request_changes 와만 공존한다.
  //   heartbeat/comment 경로는 이 필드를 넘기지 않으므로 구조화 계층 태그는 오직 공식 workflow API 만 제출 가능.
  const findings = input.findings && input.findings.length > 0 && input.verdict === "request_changes"
    ? workflowVerdictFindingsSchema.parse(input.findings)
    : null;
  // [qa mechanical remediation] remediations 도 request_changes 와만 공존한다(스키마 refine 보장).
  //   heartbeat/comment 경로는 이 필드를 넘기지 않으므로 기계적 수정 지시는 오직 공식 workflow API 만 제출 가능.
  const remediations = input.remediations && input.verdict === "request_changes"
    ? workflowQaRemediationsSchema.parse(input.remediations)
    : null;
  const boundedReason = typeof input.sourceText === "string" && input.sourceText.trim().length > 0
    ? input.sourceText.trim().slice(0, 4000)
    : null;
  const payload = {
    kind: "workflow_validation_verdict",
    workflowRunId: context.workflowRunId,
    stepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    verdict: input.verdict,
    diagnostics: [],
    ...(boundedReason ? { reason: boundedReason } : {}),
    ...(acceptance ? { nonblockingAcceptance: acceptance } : {}),
    ...(findings ? { findings } : {}),
    ...(remediations ? { remediations } : {}),
  } satisfies WorkflowValidationVerdictPayload;
  const sourceKey = input.heartbeatRunId
    ? `run:${input.heartbeatRunId}`
    : `text:${hashText(input.sourceText ?? input.verdict)}`;

  const at = new Date();
  const idempotencyKey = `workflow-validation-verdict:${input.issue.companyId}:${input.issue.id}:${context.workflowStepRunId}:${sourceKey}`;
  const insert = input.db.insert(workflowTransitionEvents).values({
    companyId: input.issue.companyId,
    missionId: input.issue.missionId,
    workflowRunId: context.workflowRunId,
    workflowStepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    heartbeatRunId: input.heartbeatRunId ?? null,
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    decision: input.verdict,
    reason: input.source,
    reasonCode: input.source,
    idempotencyKey,
    payload,
    ...(correction ? { wakeupRequestId: correction.actor.wakeupRequestId,
      executionGeneration: correction.selected.followup.target.executionGeneration, createdAt: at } : {}),
  }).onConflictDoNothing();
  let verdict = input.verdict;
  if (!correction) await insert;
  else {
    const [inserted] = await insert.returning();
    const [stored] = inserted ? [inserted] : await input.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, input.issue.companyId), eq(workflowTransitionEvents.idempotencyKey, idempotencyKey)));
    requireWrite(stored);
    const { selected: h, actor, deliveryEventId } = correction, t = h.followup.target;
    const consumedAt = new Date();
    const consumed = qaCorrectionConsumptionSchema.parse({ schemaVersion: "workflow.qa-correction.consumption.v2",
      ref: h.ref, followupEventId: h.followupEventId, followup: h.followup, consumedAt: consumedAt.toISOString(),
      evidence: { kind: "workflow_verdict", eventId: stored!.id, deliveryEventId } });
    const [receipt] = await input.db.insert(workflowTransitionEvents).values({
      companyId: h.ref.companyId, missionId: h.issued.preparation.missionId, workflowRunId: h.ref.workflowRunId,
      workflowStepRunId: t.stepRunId, issueId: t.issueId, executionGeneration: t.executionGeneration,
      heartbeatRunId: actor.id, wakeupRequestId: actor.wakeupRequestId, layer: "workflow_validation",
      eventType: "qa_correction_followup_consumed", idempotencyKey: qaCorrectionConsumptionKey(h.ref.requestId),
      payload: consumed, createdAt: consumedAt,
    }).onConflictDoNothing().returning();
    // Escape the owning transaction so a losing INSERT cannot strand a new official event.
    if (!receipt) throw new WorkflowVerdictConsumptionConflict();
    const db = input.db as Tx;
    await readQaCorrectionFollowupConsumption(db, h.ref, createQaCorrectionHistorySession(db, h.ref));
    verdict = stored!.verdict as WorkflowValidationVerdictValue;
  }

  return {
    ...context,
    satisfied: true,
    verdict,
    insufficientEvidence: false,
    insufficientEvidenceReason: null,
  };
}
