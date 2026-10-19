import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { heartbeatRuns, issues, issueWorkProducts, missions, workflowRuns, workflowStepRuns,
  workflowStepOutputBindings, type Db } from "@paperclipai/db";
import type { WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { resolveWorkProductLocalFilePath } from "../../work-products.js";
import { lockQualityAttemptBudget } from "../../quality/retry-budget.js";
import { qaCorrectionProductPointerSchema, readIssuedQaCorrection,
  type IssuedQaCorrection } from "./qa-correction-reader.js";
import { readQaCorrectionFollowupDb } from "./qa-correction-followup.js";
import type { QaCorrectionDb } from "./qa-correction-authority.js";

type Product = typeof issueWorkProducts.$inferSelect;
type Current = Awaited<ReturnType<typeof readQaCorrectionFollowupDb>>;
type Producer = NonNullable<Current["revisions"][number]["workflowProducer"]>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Scope = { companyId: string; workflowRunId: string; stepId: string;
  selector: WorkProductSelectors[string]; pinnedId?: string };
export type QaCorrectionSelection = {
  issued: IssuedQaCorrection;
  revision: IssuedQaCorrection["applied"]["revisions"][number];
  candidates: Current[];
};
export type CorrectionSelectedProduct = {
  product: Product; producer: Producer; file: string; correction?: QaCorrectionSelection;
};
function requireSelection(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("workproduct_selector_correction_" + reason);
}

/** DB proof only. Candidate followups are not a choice of consumer or permission to execute. */
export async function readQaCorrectionSelectedProduct(db: QaCorrectionDb, scope: Scope, product: Product) {
  const pointer = qaCorrectionProductPointerSchema.safeParse(product.metadata?.qaCorrection);
  requireSelection(pointer.success, "pointer");
  const issued = await readIssuedQaCorrection(db, { companyId: scope.companyId,
    workflowRunId: scope.workflowRunId, appliedEventId: pointer.data.appliedEventId });
  const revision = issued.applied.revisions.find(r => r.revisionId === pointer.data.revisionId
    && r.workProductId === product.id);
  requireSelection(revision && issued.preparation.producer.stepId === scope.stepId, "revision");
  const candidates: Current[] = [];
  let producer: Producer | null = null;
  for (const followup of issued.followups.filter(f => f.revisionIds.includes(revision.revisionId))) {
    // This public current reader also invokes readIssuedQaCorrectionFollowup and its original lineage reader.
    const candidate = await readQaCorrectionFollowupDb(db, { companyId: scope.companyId,
      workflowRunId: scope.workflowRunId, appliedEventId: pointer.data.appliedEventId,
      requestId: followup.requestId }, readIssuedQaCorrection);
    const proof = candidate.revisions.find(r => r.revision.revisionId === revision.revisionId);
    requireSelection(proof?.workflowProducer && same(proof.revision, revision)
      && same(candidate.issued.preparation, issued.preparation)
      && same(candidate.issued.applied, issued.applied), "provenance");
    requireSelection(producer === null || same(producer, proof.workflowProducer), "provenance");
    producer = proof.workflowProducer;
    candidates.push(candidate);
  }
  requireSelection(producer && candidates.length, "provenance");
  const current = candidates.flatMap(c => c.database.products).find(p => p.id === product.id);
  const file = current && resolveWorkProductLocalFilePath(current);
  requireSelection(current && current.type === scope.selector.type && current.title === scope.selector.title
    && file && ["local", "local_file"].includes(current.provider)
    && path.resolve(file) === path.resolve(revision.root, revision.mainRelativePath), "file");
  return { product: current, producer, file, correction: { issued, revision, candidates } };
}

/** Only this consumer-aware boundary chooses an exact target and its existing C03 binding. */
export function selectQaCorrectionConsumer(correction: QaCorrectionSelection,
  consumerStepRunId: string, referencedStepId: string) {
  const matches = [];
  for (const candidate of correction.candidates) {
    if (candidate.followup.target.stepRunId !== consumerStepRunId) continue;
    for (const expected of correction.issued.preparation.bindings) {
      if (expected.referencedStepId !== referencedStepId
        || !same(expected.consumer, candidate.followup.target)
        || expected.expectedProductId !== correction.revision.sourceProductId) continue;
      const change = correction.issued.applied.bindingChanges.find(b => b.bindingId === expected.bindingId);
      const binding = candidate.database.bindings.find(b => b?.row.id === expected.bindingId);
      if (change?.fromProductId === correction.revision.sourceProductId
        && change.toProductId === correction.revision.workProductId && binding
        && binding.row.consumerStepRunId === consumerStepRunId
        && binding.row.referencedStepId === referencedStepId
        && binding.row.workProductId === correction.revision.workProductId) matches.push({ candidate, binding });
    }
  }
  requireSelection(matches.length === 1, "consumer_binding");
  return matches[0]!;
}

type InputScope = { companyId: string; workflowRunId: string;
  consumerStepRunId: string; selectors: WorkProductSelectors };

/** Preclassification is SELECT-only. Ordinary/seeded selection remains with the existing selector. */
export async function readSelectedQaCorrections(db: QaCorrectionDb, scope: InputScope) {
  const pins = await db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, scope.companyId),
    eq(workflowStepOutputBindings.workflowRunId, scope.workflowRunId),
    eq(workflowStepOutputBindings.consumerStepRunId, scope.consumerStepRunId)));
  const result = [];
  for (const [stepId, selector] of Object.entries(scope.selectors)) {
    const pin = pins.find(b => b.referencedStepId === stepId);
    const rows = await db.select({ product: issueWorkProducts }).from(workflowStepRuns)
      .innerJoin(issueWorkProducts, eq(issueWorkProducts.issueId, workflowStepRuns.issueId))
      .where(and(eq(workflowStepRuns.workflowRunId, scope.workflowRunId), eq(workflowStepRuns.stepId, stepId),
        eq(issueWorkProducts.companyId, scope.companyId), eq(issueWorkProducts.type, selector.type),
        eq(issueWorkProducts.title, selector.title),
        pin ? eq(issueWorkProducts.id, pin.workProductId) : ne(issueWorkProducts.status, "archived")));
    if (rows.length !== 1 || !Object.hasOwn(rows[0]!.product.metadata ?? {}, "qaCorrection")) continue;
    const selected = await readQaCorrectionSelectedProduct(db, { ...scope, stepId, selector,
      pinnedId: pin?.workProductId }, rows[0]!.product);
    const consumer = selectQaCorrectionConsumer(selected.correction, scope.consumerStepRunId, stepId);
    requireSelection(pin && consumer.binding.row.id === pin.id, "consumer_binding");
    result.push({ stepId, selected, consumer });
  }
  return result;
}
type Selections = Awaited<ReturnType<typeof readSelectedQaCorrections>>;

/** A changed classification aborts; never acquire a new quality prefix after run/step locks. */
export function assertQaCorrectionSelectionUnchanged(before: Selections, after: Selections) {
  const identity = (rows: Selections) => rows.map(({ stepId, selected, consumer }) => ({
    stepId, productId: selected.product.id, preparation: selected.correction.issued.preparation,
    applied: selected.correction.issued.applied, revision: selected.correction.revision,
    candidates: selected.correction.candidates.map(c => ({
      ref: c.ref, followup: c.followup, followupEventId: c.followupEventId,
    })),
    ref: consumer.candidate.ref, binding: consumer.binding,
  }));
  requireSelection(same(identity(before), identity(after)), "selection_changed");
}

/** Root owner only. No file IO, new reservation, use or preapply eligibility check. */
export async function lockQaCorrectionSelections(tx: Tx, scope: InputScope, selections: Selections) {
  const preparations = selections.map(s => s.selected.correction.issued.preparation);
  const authorities = preparations.flatMap(p => p.authority.kind === "quality_current_output" ? [p.authority] : []);
  const actions = [...new Map(authorities.map(a => [a.actionId, a])).values()].sort((a, b) =>
    a.policyVersionId.localeCompare(b.policyVersionId) || a.groupId.localeCompare(b.groupId)
      || a.actionId.localeCompare(b.actionId));
  for (const authority of actions) {
    await lockQualityAttemptBudget(tx, { companyId: scope.companyId, actionId: authority.actionId, now: new Date() });
  }
  const missionIds = [...new Set(preparations.map(p => p.missionId))];
  await tx.select({ id: missions.id }).from(missions).where(and(eq(missions.companyId, scope.companyId),
    inArray(missions.id, missionIds))).orderBy(asc(missions.id)).for("no key update");
  await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, scope.companyId),
    eq(workflowRuns.id, scope.workflowRunId))).for("no key update");
  const attempts = preparations.flatMap(p => [p.producer, ...p.authority.verdicts.map(v => v.qa),
    ...p.bindings.map(b => b.consumer)]);
  const heartbeatIds = new Set(selections.map(s => s.selected.producer.heartbeatRunId));
  for (const p of preparations) {
    p.authority.verdicts.forEach(v => heartbeatIds.add(v.heartbeatRunId));
    if (p.authority.kind === "quality_current_output") {
      heartbeatIds.add(p.authority.source.heartbeatRunId);
      heartbeatIds.add(p.authority.verifierRunId);
    }
  }
  await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), inArray(heartbeatRuns.id, [...heartbeatIds])))
    .orderBy(asc(heartbeatRuns.id)).for("update");
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId),
    inArray(issues.id, attempts.map(a => a.issueId)))).orderBy(asc(issues.id)).for("update");
  await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, scope.workflowRunId),
    or(inArray(workflowStepRuns.id, [scope.consumerStepRunId, ...attempts.map(a => a.stepRunId)]),
      inArray(workflowStepRuns.stepId, Object.keys(scope.selectors)))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  const productIds = selections.flatMap(s => [...s.selected.correction.issued.preparation.sources.map(p => p.productId),
    ...s.selected.correction.issued.applied.revisions.map(r => r.workProductId)]);
  await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, scope.companyId), inArray(issueWorkProducts.id, productIds)))
    .orderBy(asc(issueWorkProducts.id)).for("update");
  await tx.select({ id: workflowStepOutputBindings.id }).from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, scope.companyId),
    eq(workflowStepOutputBindings.workflowRunId, scope.workflowRunId),
    inArray(workflowStepOutputBindings.id, preparations.flatMap(p => p.bindings.map(b => b.bindingId)))))
    .orderBy(asc(workflowStepOutputBindings.id)).for("update");
}
