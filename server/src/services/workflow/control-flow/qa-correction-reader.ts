import path from "node:path";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  assets, heartbeatRuns, issueAttachments, issueWorkProducts, qualityEvidenceRefs,
  workflowStepOutputBindings, workflowTransitionEvents,
} from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared";
import { HttpError } from "../../../errors.js";
import { evidenceContractSchema, hashContract } from "../../quality/contract.js";
import { producerAttempt } from "../../work-products/producer-attempt.js";
import { resolveWorkProductLocalFilePath } from "../../work-products/producer-seal.js";
import {
  assertQaCorrectionEventLinks, hashQaCorrectionPayload, parseQaCorrectionEventPayload,
  qaCorrectionAppliedKey, qaCorrectionFollowupKey, qaCorrectionPreparationKey, qaCorrectionSourceMeasuredKey,
  type QaCorrectionApplied, type QaCorrectionAttempt, type QaCorrectionFollowup,
  type QaCorrectionPreparation, type QaCorrectionSourceMeasured,
} from "./qa-correction-contract.js";
import {
  QaCorrectionReadError, readQaCorrectionAttempt, readQaCorrectionQuality, readQaCorrectionScope,
  readQaCorrectionVerdict, requireQaCorrection, type QaCorrectionDb,
} from "./qa-correction-authority.js";

// Product metadata is a lookup hint only; every use below reads the actual issuance chain.
export const qaCorrectionProductPointerSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.product.v1"),
  appliedEventId: z.string().uuid(), revisionId: z.string().uuid(),
}).strict();
export interface QaCorrectionSourceRead {
  product: typeof issueWorkProducts.$inferSelect;
  file: string;
  origin: "registered_legacy" | "workflow_producer";
  consumerAuthority: "requires_existing_selector_and_byte_verification";
}
export interface IssuedQaCorrection {
  preparation: QaCorrectionPreparation;
  sourceMeasured: QaCorrectionSourceMeasured;
  applied: QaCorrectionApplied;
  followups: QaCorrectionFollowup[];
  sources: QaCorrectionSourceRead[];
  currentConsumption: "requires_current_authority_cancellation_and_byte_checks";
}
type Scope = { companyId: string; workflowRunId: string; appliedEventId: string };
type Event = typeof workflowTransitionEvents.$inferSelect;

function productFile(product: typeof issueWorkProducts.$inferSelect): string {
  const ref = product.url ?? product.externalId ?? ["path", "filePath", "artifactPath", "outputPath"]
    .map(key => product.metadata?.[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const file = resolveWorkProductLocalFilePath(product) ?? (typeof ref === "string" && path.isAbsolute(ref) ? ref : null);
  requireQaCorrection(file && path.isAbsolute(file), "source");
  return path.resolve(file);
}
function pointer(product: typeof issueWorkProducts.$inferSelect) {
  const parsed = qaCorrectionProductPointerSchema.safeParse(product.metadata?.qaCorrection);
  requireQaCorrection(parsed.success, "lineage");
  return parsed.data;
}
function inside(file: string, directory: string) {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Shared by new-issuance validation and history. No branch confers ordinary selector authority. */
export async function readQaCorrectionSources(db: QaCorrectionDb, p: QaCorrectionPreparation,
  current: boolean, ancestors = new Set<string>()): Promise<QaCorrectionSourceRead[]> {
  const sources: QaCorrectionSourceRead[] = [];
  for (const source of p.sources) {
    const [product] = await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, source.productId), eq(issueWorkProducts.companyId, p.companyId)));
    requireQaCorrection(product && product.issueId === p.producer.issueId
      && (!current || product.status === "active") && product.createdAt <= new Date(p.preparedAt), "source");
    const file = productFile(product), provenance = source.provenance;
    let origin: QaCorrectionSourceRead["origin"] = "registered_legacy";
    if (provenance.kind === "prior_correction") {
      requireQaCorrection(!Object.hasOwn(product.metadata ?? {}, "workflowProducer"), "source");
      const hint = pointer(product);
      requireQaCorrection(hint.appliedEventId === provenance.appliedEventId, "lineage");
      const prior = await readIssued(db, { companyId: p.companyId, workflowRunId: p.workflowRunId,
        appliedEventId: provenance.appliedEventId }, ancestors, false);
      const revision = prior.applied.revisions.find(r => r.workProductId === product.id && r.revisionId === hint.revisionId);
      requireQaCorrection(revision && prior.preparation.missionId === p.missionId
        && prior.preparation.producer.stepRunId === p.producer.stepRunId
        && prior.preparation.producer.issueId === p.producer.issueId
        && new Date(prior.applied.appliedAt) <= new Date(p.preparedAt), "lineage");
      origin = prior.sources.find(s => s.product.id === revision.sourceProductId)!.origin;
    } else {
      requireQaCorrection(!Object.hasOwn(product.metadata ?? {}, "qaCorrection"), "source");
      const present = Object.hasOwn(product.metadata ?? {}, "workflowProducer");
      if (provenance.kind === "registered_legacy") {
        requireQaCorrection(!present, "source");
        // Preserve the existing registration boundary, which requires an absolute registered ref.
        const ref = product.url ?? product.externalId ?? ["path", "filePath", "artifactPath", "outputPath"]
          .map(key => product.metadata?.[key]).find(value => typeof value === "string" && value.trim());
        requireQaCorrection(typeof ref === "string" && path.isAbsolute(ref) && path.resolve(ref) === file, "source");
      } else {
        const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
        requireQaCorrection(present && parsed.success
          && hashQaCorrectionPayload(parsed.data) === hashQaCorrectionPayload(provenance.workflowProducer), "source");
        const producer = parsed.data, attempt = p.producer;
        requireQaCorrection(producer.companyId === p.companyId && producer.missionId === p.missionId
          && producer.workflowRunId === p.workflowRunId && producer.stepRunId === attempt.stepRunId
          && producer.stepId === attempt.stepId && producer.executionGeneration === attempt.executionGeneration
          && producer.retryCount === attempt.retryCount && producer.iterationIndex === attempt.iterationIndex
          && product.createdByRunId === producer.heartbeatRunId && product.sourceExecutionGeneration === producer.executionGeneration
          && ["local", "local_file"].includes(product.provider), "source");
        const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producer.heartbeatRunId));
        requireQaCorrection(heartbeat && heartbeat.companyId === p.companyId && heartbeat.issueId === attempt.issueId
          && heartbeat.workflowStepRunId === attempt.stepRunId && heartbeat.workflowExecutionGeneration === attempt.executionGeneration, "source");
        const step = await readQaCorrectionAttempt(db, p, attempt, current);
        try { await producerAttempt(db, heartbeat, { ...step, ...attempt, id: step.id }); }
        catch (error) { if (!(error instanceof HttpError)) throw error; throw new QaCorrectionReadError("source"); }
        origin = "workflow_producer";
      }
    }
    sources.push({ product, file, origin, consumerAuthority: "requires_existing_selector_and_byte_verification" });
  }
  for (const binding of p.bindings) {
    const [row] = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, binding.bindingId));
    requireQaCorrection(row && row.companyId === p.companyId && row.workflowRunId === p.workflowRunId
      && row.consumerStepRunId === binding.consumer.stepRunId && row.referencedStepId === binding.referencedStepId
      && binding.referencedStepId === p.producer.stepId, "binding");
    await readQaCorrectionAttempt(db, p, binding.consumer, current);
    if (current) requireQaCorrection(row.workProductId === binding.expectedProductId
      && (row.sourceExecutionGeneration === null || row.sourceExecutionGeneration === p.producer.executionGeneration), "binding");
  }
  return sources;
}

function eventScope(row: Event, p: QaCorrectionPreparation, attempt: QaCorrectionAttempt, key: string) {
  requireQaCorrection(row.companyId === p.companyId && row.missionId === p.missionId
    && row.workflowRunId === p.workflowRunId && row.workflowStepRunId === attempt.stepRunId
    && row.issueId === attempt.issueId && row.executionGeneration === attempt.executionGeneration
    && row.idempotencyKey === key && row.layer === "workflow_validation", "record");
}
async function readEvent(db: QaCorrectionDb, scope: Scope, id: string, type: string): Promise<Event> {
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, id), eq(workflowTransitionEvents.companyId, scope.companyId),
    eq(workflowTransitionEvents.workflowRunId, scope.workflowRunId), eq(workflowTransitionEvents.eventType, type)));
  requireQaCorrection(row, "record");
  return row;
}

/** A moved binding is accepted only through actual later issuance records for that SAME binding. */
async function verifyBindingSuccessors(db: QaCorrectionDb, scope: Scope, issued: IssuedQaCorrection) {
  for (const change of issued.applied.bindingChanges) {
    const [binding] = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, change.bindingId));
    requireQaCorrection(binding, "binding");
    let productId = binding.workProductId;
    const visited = new Set<string>();
    while (productId !== change.toProductId) {
      requireQaCorrection(!visited.has(productId), "lineage");
      visited.add(productId);
      const [product] = await db.select().from(issueWorkProducts).where(and(
        eq(issueWorkProducts.id, productId), eq(issueWorkProducts.companyId, scope.companyId)));
      requireQaCorrection(product, "binding");
      const hint = pointer(product);
      const successor = await readIssued(db, { ...scope, appliedEventId: hint.appliedEventId }, new Set(), false);
      const link = successor.applied.bindingChanges.find(c => c.bindingId === change.bindingId && c.toProductId === productId);
      const revision = successor.applied.revisions.find(r => r.workProductId === productId && r.revisionId === hint.revisionId);
      requireQaCorrection(link && revision && revision.sourceProductId === link.fromProductId
        && new Date(successor.applied.appliedAt) >= new Date(issued.applied.appliedAt), "binding");
      productId = link.fromProductId;
    }
  }
}

async function verifyQualityUse(db: QaCorrectionDb, p: QaCorrectionPreparation, a: QaCorrectionApplied) {
  const authority = p.authority;
  if (authority.kind !== "quality_current_output") return;
  const [receipt] = await db.select().from(qualityEvidenceRefs).where(and(
    eq(qualityEvidenceRefs.companyId, p.companyId), eq(qualityEvidenceRefs.id, a.qualityUseEvidenceRefId!)));
  const contract = evidenceContractSchema.safeParse(receipt?.qualityContract);
  requireQaCorrection(receipt && contract.success && receipt.status === "verified" && contract.data.kind === "use"
    && receipt.qualityActionId === authority.actionId && receipt.reviewItemId === authority.reviewItemId
    && receipt.sourceRunId === authority.source.heartbeatRunId && hashContract(contract.data.source) === hashContract(authority.source), "evidence");
  const evidence = contract.data, scope = evidence.scope;
  requireQaCorrection(scope?.kind === "output_correction" && scope.companyId === p.companyId
    && scope.actionId === authority.actionId && scope.verifierRunId === authority.verifierRunId
    && scope.verifierEpoch === authority.verifierEpoch && hashContract(scope.source) === hashContract(authority.source)
    && new Date(evidence.verifiedAt) <= new Date(a.appliedAt)
    && (!evidence.expiresAt || new Date(evidence.expiresAt) > new Date(a.appliedAt)), "evidence");
  const [attachment] = await db.select().from(issueAttachments).where(and(
    eq(issueAttachments.companyId, p.companyId), eq(issueAttachments.id, evidence.ref.attachmentId)));
  const [asset] = attachment ? await db.select().from(assets).where(and(
    eq(assets.companyId, p.companyId), eq(assets.id, attachment.assetId))) : [];
  requireQaCorrection(attachment && attachment.issueId === authority.source.issueId && asset
    && asset.sha256 === evidence.ref.sha256, "evidence");
}

async function readIssued(db: QaCorrectionDb, scope: Scope, ancestors: Set<string>, checkBindings: boolean): Promise<IssuedQaCorrection> {
  requireQaCorrection(!ancestors.has(scope.appliedEventId), "lineage");
  const visited = new Set(ancestors).add(scope.appliedEventId);
  const appliedRow = await readEvent(db, scope, scope.appliedEventId, "qa_remediation_applied");
  const a = parseQaCorrectionEventPayload("qa_remediation_applied", appliedRow.payload);
  const preparedRow = await readEvent(db, scope, a.preparationEventId, "qa_correction_prepared");
  const measuredRow = await readEvent(db, scope, a.sourceMeasuredEventId, "qa_correction_source_measured");
  const p = parseQaCorrectionEventPayload("qa_correction_prepared", preparedRow.payload);
  const m = parseQaCorrectionEventPayload("qa_correction_source_measured", measuredRow.payload);
  requireQaCorrection(p.correctionId === preparedRow.id && p.companyId === scope.companyId
    && p.workflowRunId === scope.workflowRunId && preparedRow.createdAt <= measuredRow.createdAt
    && measuredRow.createdAt <= appliedRow.createdAt && new Date(p.preparedAt) <= new Date(m.measuredAt)
    && new Date(m.measuredAt) <= new Date(a.appliedAt), "record");
  eventScope(preparedRow, p, p.producer, qaCorrectionPreparationKey(preparedRow.payload));
  eventScope(measuredRow, p, p.producer, qaCorrectionSourceMeasuredKey(p.correctionId));
  eventScope(appliedRow, p, p.producer, qaCorrectionAppliedKey(p.correctionId));
  const followupRows: Event[] = [], followups: QaCorrectionFollowup[] = [];
  for (const id of a.followupEventIds) {
    const row = await readEvent(db, scope, id, "qa_correction_followup_requested");
    const followup = parseQaCorrectionEventPayload("qa_correction_followup_requested", row.payload);
    eventScope(row, p, followup.target, qaCorrectionFollowupKey(p.correctionId, followup.target));
    requireQaCorrection(row.createdAt >= appliedRow.createdAt, "record");
    await readQaCorrectionAttempt(db, p, followup.target, false);
    followupRows.push(row); followups.push(followup);
  }
  assertQaCorrectionEventLinks({ preparation: preparedRow.payload,
    sourceMeasured: { eventId: measuredRow.id, payload: measuredRow.payload },
    applied: { eventId: appliedRow.id, payload: appliedRow.payload },
    followups: followupRows.map(row => ({ eventId: row.id, payload: row.payload })) });
  await readQaCorrectionScope(db, p, false);
  for (const verdict of p.authority.verdicts) {
    const fact = await readQaCorrectionVerdict(db, p, verdict, false);
    requireQaCorrection(fact.event.createdAt <= preparedRow.createdAt, "verdict");
  }
  await readQaCorrectionQuality(db, p, false, new Date(a.appliedAt));
  const sources = await readQaCorrectionSources(db, p, false, visited);
  for (const revision of a.revisions) {
    const [product] = await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, revision.workProductId), eq(issueWorkProducts.companyId, p.companyId)));
    requireQaCorrection(product && product.issueId === p.producer.issueId && ["local", "local_file"].includes(product.provider)
      && !Object.hasOwn(product.metadata ?? {}, "workflowProducer"), "source");
    const hint = pointer(product), source = sources.find(s => s.product.id === revision.sourceProductId)!;
    requireQaCorrection(hint.appliedEventId === appliedRow.id && hint.revisionId === revision.revisionId
      && path.isAbsolute(revision.root) && path.resolve(revision.root) === revision.root
      && inside(path.resolve(revision.root, revision.mainRelativePath), revision.root)
      && productFile(product) === path.resolve(revision.root, revision.mainRelativePath)
      && productFile(product) !== source.file && path.basename(source.file) === path.basename(revision.mainRelativePath), "source");
    requireQaCorrection(revision.files.every(f => inside(path.resolve(revision.root, f.relativePath), revision.root)), "source");
  }
  await verifyQualityUse(db, p, a);
  const issued: IssuedQaCorrection = { preparation: p, sourceMeasured: m, applied: a, followups, sources,
    currentConsumption: "requires_current_authority_cancellation_and_byte_checks" };
  if (checkBindings) await verifyBindingSuccessors(db, scope, issued);
  return issued;
}

/** C03/C12 historical issuance only. New QA/PASS and B→C must not require the source verdict to stay latest. */
export async function readIssuedQaCorrection(db: QaCorrectionDb, scope: Scope): Promise<IssuedQaCorrection> {
  return readIssued(db, scope, new Set(), true);
}
