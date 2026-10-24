import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests, agents, assets, companies, createDb, heartbeatRuns, issueAttachments,
  issueWorkProducts, issues, missions, qualityActions, qualityEvidenceRefs, workflowDefinitions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { SourceAttempt, WorkflowQaRemediations } from "@paperclipai/shared";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { hashContract } from "../../services/quality/contract.js";
import {
  hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionAppliedKey, qaCorrectionFollowupKey,
  qaCorrectionPreparationKey, qaCorrectionSourceMeasuredKey,
  type QaCorrectionApplied, type QaCorrectionAttempt, type QaCorrectionFollowup,
  type QaCorrectionPreparation, type QaCorrectionSourceMeasured,
} from "../../services/workflow/control-flow/qa-correction-contract.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { admittedProducer } from "./admitted-producer.js";
import { seedQualityFixture, type QualityFixture } from "./quality-fixture.js";
import { reviewItemForAction } from "./quality-proofs.js";

export async function createQaCorrectionTestDb() {
  const temporary = await startEmbeddedPostgresTestDatabase("qa-correction-authority-");
  const clients: Db[] = [];
  const connect = () => { const db = createDb(temporary.connectionString); clients.push(db); return db; };
  return { db: connect(), connect, close: async () => {
    const results = await Promise.allSettled(clients.map(db => db.$client.end({ timeout: 5 })));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), "owned DB clients did not close");
    await temporary.cleanup();
  } };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const beforeSha256 = digest("old"), afterSha256 = digest("new");
export const attempt = (row: typeof workflowStepRuns.$inferSelect): QaCorrectionAttempt => ({
  stepRunId: row.id, stepId: row.stepId, issueId: row.issueId!, executionGeneration: row.executionGeneration,
  retryCount: row.retryCount, iterationIndex: row.iterationIndex,
});
export interface CorrectionFixture {
  preparation: QaCorrectionPreparation;
  otherCompanyId: string;
  producer: typeof workflowStepRuns.$inferSelect;
  qa: typeof workflowStepRuns.$inferSelect;
  productId: string;
  bindingId: string;
  producerHeartbeatId: string;
  verdictHeartbeatId: string;
  verdictWakeId: string;
  remediations: WorkflowQaRemediations;
  quality: QualityFixture | null;
}

/** Controlled real rows. No artifact bytes, adapters, product issuance or actual QA are executed. */
export async function seedQaCorrection(db: Db, mode: "registered_legacy" | "identity" | "sealed" = "registered_legacy",
  withQuality = false): Promise<CorrectionFixture> {
  const quality = withQuality ? await seedQualityFixture(db) : null;
  const companyId = quality?.companyId ?? randomUUID(), otherCompanyId = quality?.otherCompanyId ?? randomUUID();
  const author = quality?.authorAgentId ?? randomUUID(), verifier = quality?.verifierAgentId ?? randomUUID();
  if (!quality) {
    await db.insert(companies).values([
      { id: companyId, name: "Correction owner", issuePrefix: `QC${companyId.slice(0, 8)}` },
      { id: otherCompanyId, name: "Foreign owner", issuePrefix: `QF${otherCompanyId.slice(0, 8)}` },
    ]);
    await db.insert(agents).values([{ id: author, companyId, name: "Producer" }, { id: verifier, companyId, name: "Verifier" }]);
  }
  const missionId = randomUUID(), workflowId = randomUUID(), workflowRunId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, title: "Correction fixture", ownerAgentId: author, status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Correction fixture", stepsJson: [
    { id: "produce", name: "Produce", agentId: author, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
    { id: "qa-check", name: "QA", agentId: verifier, dependencies: ["produce"] },
  ] });
  await db.insert(workflowRuns).values({ id: workflowRunId, companyId, missionId, workflowId, status: "running", triggeredBy: "test" });
  const [producerIssue] = await db.insert(issues).values({ companyId, missionId, title: "Produce", status: "done", originKind: "workflow_execution" }).returning();
  const [qaIssue] = await db.insert(issues).values({ companyId, missionId, title: "[QA] Check", status: "todo", originKind: "workflow_execution" }).returning();
  const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "produce", issueId: producerIssue!.id,
    status: "completed", completedAt: new Date(Date.now() - 1000) }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "qa-check", issueId: qaIssue!.id, status: "failed" }).returning();
  const producerHeartbeatId = randomUUID();
  await admittedProducer(db, { companyId, agentId: author, issueId: producerIssue!.id, stepRunId: producer!.id, heartbeatId: producerHeartbeatId });
  await db.update(heartbeatRuns).set({ executionEpoch: 1 }).where(eq(heartbeatRuns.id, producerHeartbeatId));
  const verdictWakeId = randomUUID(), verdictHeartbeatId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: verdictWakeId, companyId, agentId: verifier,
    source: "workflow.dispatch", workflowStepRunId: qa!.id });
  await db.insert(heartbeatRuns).values({ id: verdictHeartbeatId, companyId, agentId: verifier,
    issueId: qaIssue!.id, wakeupRequestId: verdictWakeId, status: "succeeded", executionEpoch: 1,
    workflowStepRunId: withQuality ? qa!.id : null, workflowExecutionGeneration: withQuality ? qa!.executionGeneration : null });
  const file = `/qa-correction-fixture/${companyId}/a/report.html`;
  const remediations: WorkflowQaRemediations = { items: [{ op: "string_replace", file, find: "old", replace: "new" }] };
  await recordWorkflowValidationVerdict({ db, issue: qaIssue!, source: "workflow_api", verdict: "request_changes",
    heartbeatRunId: verdictHeartbeatId, remediations });
  const [verdict] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, verdictHeartbeatId));
  if (!verdict) throw new Error("official verdict fixture was not recorded");
  const workflowProducer = { schemaVersion: "workflow.work-product-producer.v1" as const, companyId, missionId, workflowRunId,
    stepRunId: producer!.id, stepId: producer!.stepId, executionGeneration: producer!.executionGeneration,
    retryCount: producer!.retryCount, iterationIndex: producer!.iterationIndex, heartbeatRunId: producerHeartbeatId,
    ...(mode === "sealed" ? { sha256: beforeSha256, byteSize: 3 } : {}) };
  const [product] = await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue!.id, type: "file",
    provider: "local_file", title: "report", status: "active", url: file,
    createdByRunId: mode === "registered_legacy" ? null : producerHeartbeatId,
    sourceExecutionGeneration: mode === "registered_legacy" ? null : producer!.executionGeneration,
    metadata: { path: file, ...(mode === "registered_legacy" ? {} : { workflowProducer }) } }).returning();
  const [binding] = await db.insert(workflowStepOutputBindings).values({ companyId, workflowRunId,
    consumerStepRunId: qa!.id, referencedStepId: "produce", workProductId: product!.id }).returning();
  const preparation: QaCorrectionPreparation = { schemaVersion: "workflow.qa-correction.prepare.v1", correctionId: randomUUID(),
    companyId, missionId, workflowRunId, dispatchAuthorityVersion: 0, producer: attempt(producer!),
    authority: { kind: "workflow_qa", verdicts: [{ eventId: verdict.id, heartbeatRunId: verdictHeartbeatId,
      qa: attempt(qa!), remediationsHash: hashQaCorrectionPayload(remediations.items) }], toolEvidence: null },
    sources: [{ productId: product!.id, provenance: mode === "registered_legacy" ? { kind: "registered_legacy" }
      : { kind: "workflow_producer", workflowProducer } }],
    bindings: [{ bindingId: binding!.id, consumer: attempt(qa!), referencedStepId: "produce", expectedProductId: product!.id }],
    preparedAt: new Date().toISOString() };
  if (quality) {
    const source: SourceAttempt = { companyId, issueId: producerIssue!.id, heartbeatRunId: producerHeartbeatId,
      executionEpoch: 1, inputHash: "ab".repeat(32), mission: { kind: "mission", id: missionId },
      workflow: { kind: "workflow_step", runId: workflowRunId, stepRunId: producer!.id,
        generation: producer!.executionGeneration, dispatchAuthorityVersion: 0 } };
    const { reviewItemId, occurrenceId } = await reviewItemForAction(db, companyId, source, producerHeartbeatId);
    const actionId = randomUUID(), intentKey = `correction-${actionId}`;
    const target = { kind: "current_output" as const, source }, effect = { kind: "repair_supported_output" as const, target };
    const retryEnvelope = { intentKey, targetHash: hashContract(target), effectHash: hashContract(effect),
      maxExecutorAttempts: 2, deadlineAt: new Date(Date.now() + 3600000).toISOString(),
      groupId: quality.groupId, policyVersionId: quality.policyVersionId, maxCumulativeCostCents: 100 };
    await db.insert(qualityActions).values({ id: actionId, companyId, groupId: quality.groupId, kind: "current_output",
      occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId], policyVersionId: quality.policyVersionId,
      scopeVersion: 1, target, targetHash: hashContract(target), effect, effectHash: hashContract(effect), retryEnvelope,
      state: "bound", intentKey, canonicalBinding: { companyId, actionId, missionId, workflowRunId, stepRunId: qa!.id, issueId: qaIssue!.id } });
    preparation.authority = { kind: "quality_current_output", verdicts: preparation.authority.verdicts, actionId,
      groupId: quality.groupId, policyVersionId: quality.policyVersionId, intentKey, targetHash: hashContract(target),
      effectHash: hashContract(effect), retryEnvelopeHash: hashContract(retryEnvelope), source, reviewItemId,
      verifierRunId: verdictHeartbeatId, verifierEpoch: 1 };
    preparation.preparedAt = new Date().toISOString();
  }
  return { preparation, otherCompanyId, producer: producer!, qa: qa!, productId: product!.id, bindingId: binding!.id,
    producerHeartbeatId, verdictHeartbeatId, verdictWakeId, remediations, quality };
}

/** Reader INPUT ONLY: these inserts do not exercise a product correction writer or QA consumer. */
export async function issueQaCorrectionFixture(db: Db, fixture: CorrectionFixture, p = fixture.preparation) {
  const at = Date.parse(p.preparedAt), measuredId = randomUUID(), appliedId = randomUUID(), followupId = randomUUID();
  const revisionId = randomUUID(), workProductId = randomUUID(), sourceId = p.sources[0]!.productId;
  const root = `/qa-correction-fixture/${p.companyId}/${revisionId}`;
  let sourceFiles: QaCorrectionSourceMeasured["sources"][number]["files"] = [
    { role: "main", relativePath: "report.html", sha256: beforeSha256, byteSize: 3 },
  ];
  const provenance = p.sources[0]!.provenance;
  if (provenance.kind === "prior_correction") {
    const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, provenance.appliedEventId));
    if (!row || row.eventType !== "qa_remediation_applied") throw new Error("fixture prior application");
    const prior = parseQaCorrectionEventPayload("qa_remediation_applied", row.payload);
    const revision = prior.revisions.find(r => r.workProductId === sourceId);
    if (!revision) throw new Error("fixture prior revision");
    sourceFiles = revision.files.map(({ role, relativePath, sha256, byteSize }) => ({ role, relativePath, sha256, byteSize }));
  }
  const m: QaCorrectionSourceMeasured = { schemaVersion: "workflow.qa-correction.source-measured.v1",
    preparationEventId: p.correctionId, preparationHash: hashQaCorrectionPayload(p),
    sources: [{ productId: sourceId, files: sourceFiles }],
    measuredAt: new Date(at + 1).toISOString() };
  const a: QaCorrectionApplied = { schemaVersion: "workflow.qa-correction.applied.v1", correctionId: p.correctionId,
    preparationEventId: p.correctionId, preparationHash: hashQaCorrectionPayload(p), sourceMeasuredEventId: measuredId,
    sourceMeasuredHash: hashQaCorrectionPayload(m), revisions: [{ revisionId, sourceProductId: sourceId, workProductId,
      root, mainRelativePath: "report.html", files: sourceFiles.map(file => ({ ...file,
        beforeSha256: file.sha256, sha256: file.role === "main" ? afterSha256 : file.sha256 })) }],
    bindingChanges: p.bindings.map(b => ({
      bindingId: b.bindingId, fromProductId: b.expectedProductId, toProductId: workProductId })),
    qualityUseEvidenceRefId: null, followupEventIds: [followupId], appliedAt: new Date(at + 2).toISOString() };
  if (p.authority.kind === "quality_current_output") {
    const authority = p.authority;
    const [asset] = await db.insert(assets).values({ companyId: p.companyId, provider: "local_disk", objectKey: randomUUID(),
      contentType: "application/json", byteSize: 3, sha256: afterSha256 }).returning();
    const [attachment] = await db.insert(issueAttachments).values({ companyId: p.companyId,
      issueId: authority.source.issueId, assetId: asset!.id }).returning();
    const [receipt] = await db.insert(qualityEvidenceRefs).values({ companyId: p.companyId,
      reviewItemId: authority.reviewItemId, qualityActionId: authority.actionId, surface: "attachment", status: "verified",
      sourceRunId: authority.source.heartbeatRunId, collectedByActorType: "system", collectedByActorId: "quality:current-output",
      qualityContract: { schemaVersion: 1, kind: "use", ref: { attachmentId: attachment!.id, sha256: afterSha256 },
        source: authority.source, scope: { kind: "output_correction", companyId: p.companyId, actionId: authority.actionId,
          source: authority.source, verifierRunId: authority.verifierRunId, verifierEpoch: authority.verifierEpoch },
        issuedBy: "quality:current-output", verifiedAt: a.appliedAt, expiresAt: null, originalRef: null } }).returning();
    a.qualityUseEvidenceRefId = receipt!.id;
  }
  const followup: QaCorrectionFollowup = { schemaVersion: "workflow.qa-correction.followup.v1", requestId: randomUUID(),
    correctionId: p.correctionId, appliedEventId: appliedId, operation: "recheck", target: p.authority.verdicts[0]!.qa,
    dispatchAuthorityVersion: p.dispatchAuthorityVersion, revisionIds: [revisionId] };
  const common = { companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId, layer: "workflow_validation" };
  await db.insert(workflowTransitionEvents).values([
    { ...common, id: p.correctionId, workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId,
      executionGeneration: p.producer.executionGeneration, eventType: "qa_correction_prepared", payload: p,
      idempotencyKey: qaCorrectionPreparationKey(p), createdAt: new Date(at) },
    { ...common, id: measuredId, workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId,
      executionGeneration: p.producer.executionGeneration, eventType: "qa_correction_source_measured", payload: m,
      idempotencyKey: qaCorrectionSourceMeasuredKey(p.correctionId), createdAt: new Date(at + 1) },
    { ...common, id: appliedId, workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId,
      executionGeneration: p.producer.executionGeneration, eventType: "qa_remediation_applied", payload: a,
      idempotencyKey: qaCorrectionAppliedKey(p.correctionId), createdAt: new Date(at + 2) },
    { ...common, id: followupId, workflowStepRunId: followup.target.stepRunId, issueId: followup.target.issueId,
      executionGeneration: followup.target.executionGeneration, eventType: "qa_correction_followup_requested", payload: followup,
      idempotencyKey: qaCorrectionFollowupKey(p.correctionId, followup.target), createdAt: new Date(at + 3) },
  ]);
  await db.insert(issueWorkProducts).values({ id: workProductId, companyId: p.companyId, issueId: p.producer.issueId,
    type: "file", provider: "local_file", title: "report", status: "active", metadata: { path: `${root}/report.html`,
      qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1", appliedEventId: appliedId, revisionId } }, createdAt: new Date(at + 2) });
  await db.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, sourceId));
  for (const change of a.bindingChanges) await db.update(workflowStepOutputBindings).set({ workProductId: change.toProductId })
    .where(eq(workflowStepOutputBindings.id, change.bindingId));
  return { appliedId, measuredId, followupId, workProductId, revisionId, preparation: p, measured: m, applied: a, followup,
    scope: { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId: appliedId } };
}

export async function appendQaVerdict(db: Db, f: CorrectionFixture, verdict: "pass" | "request_changes",
  remediations = f.remediations) {
  const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.verdictHeartbeatId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, f.qa.issueId!));
  const wakeId = randomUUID(), heartbeatId = randomUUID(), later = new Date(Date.now() + 1000);
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.preparation.companyId,
    agentId: old!.agentId, source: "workflow.dispatch", workflowStepRunId: f.qa.id });
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: f.preparation.companyId, agentId: old!.agentId,
    issueId: f.qa.issueId, wakeupRequestId: wakeId, status: "succeeded", createdAt: later });
  await recordWorkflowValidationVerdict({ db, issue: issue!, source: "workflow_api", verdict,
    heartbeatRunId: heartbeatId, ...(verdict === "request_changes" ? { remediations } : {}) });
  const [event] = await db.update(workflowTransitionEvents).set({ createdAt: later })
    .where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId)).returning();
  return { eventId: event!.id, heartbeatRunId: heartbeatId, qa: attempt(f.qa), remediationsHash: hashQaCorrectionPayload(remediations.items) };
}
