import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, qualityActions, qualityEvidenceRefs,
  qualityPolicyVersions, workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { validateQaCorrectionAuthority } from "../services/workflow/control-flow/qa-correction-authority.js";
import { isLatestQaExecution } from "../services/workflow/control-flow/qa-cap-acceptance.js";
import { loadLatestQaRemediations } from "../services/workflow/validation-verdict-ledger.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { assertQaCorrectionEventLinks, hashQaCorrectionPayload, type QaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-contract.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { legacyHtmlManualContract } from "./helpers/legacy-html-manual.js";
import {
  afterSha256, appendQaVerdict, beforeSha256, createQaCorrectionTestDb, issueQaCorrectionFixture, seedQaCorrection,
} from "./helpers/qa-correction-fixture.js";

// Oracle: C03/C12 and c03-contract-compatibility-addendum.txt. Fixture event inserts are reader
// input, not evidence of product issuance, actual QA consumption, dispatch, publication or byte IO.
describe("QA correction SELECT authority and historical issuance", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120000);
  afterAll(async () => { await owned?.close(); }, 120000);

  it.each(["registered_legacy", "identity", "sealed"] as const)("preserves supported %s source", async mode => {
    const f = await seedQaCorrection(owned.db, mode);
    const result = await validateQaCorrectionAuthority(owned.db, f.preparation);
    expect(result.status).toBe("authority_validated");
    expect(result.sources[0]!.origin).toBe(mode === "registered_legacy" ? "registered_legacy" : "workflow_producer");
    expect(result.sources[0]!.consumerAuthority).toBe("requires_existing_selector_and_byte_verification");
    expect(result.qualificationRequired).toBe("collectQualifiableQaRemediations");
    expect(result.finalizationRequired).toBe("locked_recheck_and_reservation_cas");
    const issued = await issueQaCorrectionFixture(owned.db, f);
    expect((await readIssuedQaCorrection(owned.db, issued.scope)).applied.revisions[0]!.workProductId).toBe(issued.workProductId);
  });

  it.each(["absolute whitespace", "relative whitespace", "file URL", "url priority", "externalId priority", "empty url priority"])(
    "preserves the registered legacy ref boundary: %s", async kind => {
      const f = await seedQaCorrection(owned.db), absolute = f.remediations.items[0]!.file;
      await owned.db.update(issueWorkProducts).set({
        url: kind === "file URL" ? `file://${absolute}` : kind === "url priority" ? " relative.html " : kind === "empty url priority" ? "" : null,
        externalId: kind === "externalId priority" ? " relative.html " : null,
        metadata: { path: kind === "relative whitespace" ? " report.html " : ` ${absolute} ` },
      }).where(eq(issueWorkProducts.id, f.productId));
      if (kind === "absolute whitespace") {
        const result = await validateQaCorrectionAuthority(owned.db, f.preparation);
        expect(result.sources[0]!.file).toBe(absolute);
        const issued = await issueQaCorrectionFixture(owned.db, f);
        expect((await readIssuedQaCorrection(owned.db, issued.scope)).sources[0]!.file).toBe(absolute);
      } else await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
    });

  const invalidAuthorities: Array<[string, (p: QaCorrectionPreparation) => void]> = [
    ["foreign run", p => { p.workflowRunId = randomUUID(); }],
    ["foreign mission", p => { p.missionId = randomUUID(); }],
    ["producer issue", p => { p.producer.issueId = p.authority.verdicts[0]!.qa.issueId; }],
    ["producer step", p => { p.producer.stepId = "foreign"; }],
    ["producer generation", p => { p.producer.executionGeneration += 1; }],
    ["QA generation", p => { p.authority.verdicts[0]!.qa.executionGeneration += 1; }],
    ["QA retry", p => { p.authority.verdicts[0]!.qa.retryCount += 1; }],
    ["QA iteration", p => { p.authority.verdicts[0]!.qa.iterationIndex += 1; }],
    ["QA step", p => { p.authority.verdicts[0]!.qa.stepId = "foreign"; }],
    ["dispatch authority", p => { p.dispatchAuthorityVersion += 1; }],
    ["event", p => { p.authority.verdicts[0]!.eventId = randomUUID(); }],
    ["heartbeat", p => { p.authority.verdicts[0]!.heartbeatRunId = randomUUID(); }],
    ["remediation hash", p => { p.authority.verdicts[0]!.remediationsHash = "ff".repeat(32); }],
    ["binding identity", p => { p.bindings[0]!.bindingId = randomUUID(); }],
  ];
  it.each(invalidAuthorities)("rejects %s", async (_name, mutate) => {
    const f = await seedQaCorrection(owned.db), p = structuredClone(f.preparation);
    mutate(p);
    await expect(validateQaCorrectionAuthority(owned.db, p)).rejects.toThrow();
  });

  it("rejects foreign company, original wake and present malformed attempt proof", async () => {
    const f = await seedQaCorrection(owned.db);
    await expect(validateQaCorrectionAuthority(owned.db, { ...f.preparation, companyId: f.otherCompanyId })).rejects.toThrow();
    await owned.db.update(agentWakeupRequests).set({ workflowStepRunId: f.producer.id }).where(eq(agentWakeupRequests.id, f.verdictWakeId));
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
    await owned.db.update(agentWakeupRequests).set({ workflowStepRunId: f.qa.id,
      payload: { __paperclipWorkflowProducerAttempt: { schemaVersion: 1 } } }).where(eq(agentWakeupRequests.id, f.verdictWakeId));
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
  });

  it("does not reinterpret malformed producer metadata or a partial seal as legacy", async () => {
    const f = await seedQaCorrection(owned.db);
    for (const workflowProducer of [null, { schemaVersion: "workflow.work-product-producer.v1", sha256: "ab".repeat(32) }]) {
      await owned.db.update(issueWorkProducts).set({ metadata: { path: f.remediations.items[0]!.file, workflowProducer } })
        .where(eq(issueWorkProducts.id, f.productId));
      await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
    }
    const sealed = await seedQaCorrection(owned.db, "sealed");
    const provenance = sealed.preparation.sources[0]!.provenance;
    if (provenance.kind !== "workflow_producer") throw new Error("fixture provenance");
    await owned.db.update(issueWorkProducts).set({ createdByRunId: f.producerHeartbeatId }).where(eq(issueWorkProducts.id, sealed.productId));
    await expect(validateQaCorrectionAuthority(owned.db, sealed.preparation)).rejects.toThrow();
  });

  it("checks optional tool evidence against the actual frozen attempt", async () => {
    const f = await seedQaCorrection(owned.db), requestId = "opaque:qa:request";
    const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: legacyHtmlManualContract("fixture.mjs") },
      step: {}, executionGeneration: f.qa.executionGeneration, requestId })!;
    await owned.db.update(workflowStepRuns).set({ lastDispatchRequestId: requestId, metadata: { artifactExecution: frozen } })
      .where(eq(workflowStepRuns.id, f.qa.id));
    if (f.preparation.authority.kind !== "workflow_qa") throw new Error("fixture authority");
    f.preparation.authority.toolEvidence = { requestId, executionGeneration: frozen.executionGeneration,
      contractHash: frozen.contractHash, qaConfigHash: frozen.qaConfigHash };
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).resolves.toMatchObject({ status: "authority_validated" });
    f.preparation.authority.toolEvidence.qaConfigHash = "ff".repeat(32);
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
  });

  it("keeps issued B valid after a new QA heartbeat and PASS, but refuses new issuance from the old rejection", async () => {
    const f = await seedQaCorrection(owned.db), issued = await issueQaCorrectionFixture(owned.db, f);
    await appendQaVerdict(owned.db, f, "pass");
    expect((await readIssuedQaCorrection(owned.db, issued.scope)).applied.revisions[0]!.workProductId).toBe(issued.workProductId);
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toMatchObject({ reason: "stale" });
  });

  it("preserves B history after B→C moves the same binding", async () => {
    const f = await seedQaCorrection(owned.db), b = await issueQaCorrectionFixture(owned.db, f);
    const remediation = { items: [{ op: "string_replace" as const, file: `${b.applied.revisions[0]!.root}/report.html`, find: "new", replace: "next" }] };
    const unconsumed = await appendQaVerdict(owned.db, f, "request_changes", remediation);
    expect(await isLatestQaExecution(owned.db, f.qa.issueId!, f.qa.id, unconsumed.heartbeatRunId)).toBe(true);
    expect(await loadLatestQaRemediations({ db: owned.db, companyId: f.preparation.companyId, issueId: f.qa.issueId! })).toBeNull();
    const stale = structuredClone(f.preparation); stale.authority.verdicts = [unconsumed];
    await expect(validateQaCorrectionAuthority(owned.db, stale)).rejects.toMatchObject({ reason: "stale" });
    // A separate official QA can assess B without pretending it consumed B's pending recheck.
    // Keep the original binding: C must move that same pin from B while preserving B's history.
    const [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.preparation.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const stepId = `qa-next-${randomUUID()}`;
    const sourceQa = definition!.stepsJson.find(step => (step as { id: string }).id === f.qa.stepId) as Record<string, unknown>;
    await owned.db.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson,
      { ...sourceQa, id: stepId, name: "QA of B" }] }).where(eq(workflowDefinitions.id, definition!.id));
    const [issue] = await owned.db.insert(issues).values({ companyId: f.preparation.companyId,
      missionId: f.preparation.missionId, title: "[QA] B", status: "todo", originKind: "workflow_execution" }).returning();
    const [qa] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: f.preparation.workflowRunId,
      stepId, issueId: issue!.id, status: "failed" }).returning();
    const verdict = await appendQaVerdict(owned.db, { ...f, qa: qa! }, "request_changes", remediation);
    const bHistory = await readIssuedQaCorrection(owned.db, b.scope);
    const next = structuredClone(f.preparation);
    next.correctionId = randomUUID(); next.preparedAt = new Date(Date.now() + 2000).toISOString();
    next.authority.verdicts = [verdict];
    next.sources = [{ productId: b.workProductId, provenance: { kind: "prior_correction", appliedEventId: b.appliedId } }];
    next.bindings[0]!.expectedProductId = b.workProductId;
    // C03 inter-correction integrity: C measures B's output ("new"), not the original A ("old").
    await expect(validateQaCorrectionAuthority(owned.db, next)).resolves.toMatchObject({ status: "authority_validated" });
    const c = await issueQaCorrectionFixture(owned.db, f, next);
    const [binding] = await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, f.bindingId));
    expect(binding!.workProductId).toBe(c.workProductId);
    expect(b.applied.revisions[0]!.files[0]!.sha256).toBe(afterSha256);
    expect(c.measured.sources[0]!.files).toEqual([
      { role: "main", relativePath: "report.html", sha256: afterSha256, byteSize: 3 },
    ]);
    expect(c.measured.sources[0]!.files[0]!.sha256).not.toBe(beforeSha256);
    expect(c.applied.revisions[0]!.files[0]!.beforeSha256).toBe(b.applied.revisions[0]!.files[0]!.sha256);
    expect(await readIssuedQaCorrection(owned.db, b.scope)).toEqual(bHistory);
    expect((await readIssuedQaCorrection(owned.db, c.scope)).sources[0]!.origin).toBe("registered_legacy");
  });

  it.each(["reordered", "hash", "size", "missing", "extra", "duplicate", "role", "path"])(
    "compares the entire prior output by relativePath: %s", async problem => {
      const f = await seedQaCorrection(owned.db), b = await issueQaCorrectionFixture(owned.db, f);
      const asset = { role: "asset" as const, relativePath: "assets/chart.svg", sha256: "ab".repeat(32), byteSize: 7 };
      b.measured.sources[0]!.files.push(asset);
      b.applied.revisions[0]!.files.push({ ...asset, beforeSha256: asset.sha256 });
      b.applied.sourceMeasuredHash = hashQaCorrectionPayload(b.measured);
      await owned.db.update(workflowTransitionEvents).set({ payload: b.measured }).where(eq(workflowTransitionEvents.id, b.measuredId));
      await owned.db.update(workflowTransitionEvents).set({ payload: b.applied }).where(eq(workflowTransitionEvents.id, b.appliedId));
      const verdict = await appendQaVerdict(owned.db, f, "request_changes", { items: [
        { op: "string_replace", file: `${b.applied.revisions[0]!.root}/report.html`, find: "new", replace: "next" },
      ] });
      const next = structuredClone(f.preparation);
      next.correctionId = randomUUID(); next.preparedAt = new Date(Date.now() + 2000).toISOString();
      next.authority.verdicts = [verdict];
      next.sources = [{ productId: b.workProductId, provenance: { kind: "prior_correction", appliedEventId: b.appliedId } }];
      next.bindings[0]!.expectedProductId = b.workProductId;
      const c = await issueQaCorrectionFixture(owned.db, f, next);
      // Read the actual B record, including its asset; keep C's own links valid in every cross-chain counterexample.
      expect(c.measured.sources[0]!.files).toEqual([
        { role: "main", relativePath: "report.html", sha256: afterSha256, byteSize: 3 }, asset,
      ]);
      const measured = structuredClone(c.measured), applied = structuredClone(c.applied), files = measured.sources[0]!.files;
      if (problem === "reordered") files.reverse();
      if (problem === "hash") files[0]!.sha256 = "ff".repeat(32);
      if (problem === "size") files[0]!.byteSize += 1;
      if (problem === "missing") files.splice(1, 1);
      if (problem === "extra") files.push({ ...asset, relativePath: "extra.svg" });
      if (problem === "duplicate") files.push({ ...asset });
      if (problem === "role") files[1]!.role = "ancillary";
      if (problem === "path") files[1]!.relativePath = "assets/other.svg";
      applied.sourceMeasuredHash = hashQaCorrectionPayload(measured);
      applied.revisions[0]!.files = files.map(file => ({ ...file, beforeSha256: file.sha256 }));
      const links = () => assertQaCorrectionEventLinks({ preparation: next,
        sourceMeasured: { eventId: c.measuredId, payload: measured }, applied: { eventId: c.appliedId, payload: applied },
        followups: [{ eventId: c.followupId, payload: c.followup }] });
      if (problem === "duplicate") expect(links).toThrow();
      else expect(links).not.toThrow();
      await owned.db.update(workflowTransitionEvents).set({ payload: measured }).where(eq(workflowTransitionEvents.id, c.measuredId));
      await owned.db.update(workflowTransitionEvents).set({ payload: applied }).where(eq(workflowTransitionEvents.id, c.appliedId));
      if (problem === "reordered") {
        expect((await readIssuedQaCorrection(owned.db, c.scope)).sourceMeasured.sources[0]!.files).toEqual(files);
        expect((await readIssuedQaCorrection(owned.db, b.scope)).applied.revisions[0]!.workProductId).toBe(b.workProductId);
      } else if (problem === "duplicate") await expect(readIssuedQaCorrection(owned.db, c.scope)).rejects.toThrow();
      else await expect(readIssuedQaCorrection(owned.db, c.scope)).rejects.toMatchObject({ reason: "lineage" });
    });

  it.each(["missing measurement", "key", "hash", "row scope", "followup", "before hash", "binding", "B registration"])(
    "rejects broken historical %s", async problem => {
      const f = await seedQaCorrection(owned.db), issued = await issueQaCorrectionFixture(owned.db, f);
      if (problem === "missing measurement") await owned.db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, issued.measuredId));
      if (problem === "key") await owned.db.update(workflowTransitionEvents).set({ idempotencyKey: `forged:${randomUUID()}` }).where(eq(workflowTransitionEvents.id, issued.appliedId));
      if (problem === "hash") await owned.db.update(workflowTransitionEvents).set({ payload: { ...issued.applied, preparationHash: "ff".repeat(32) } }).where(eq(workflowTransitionEvents.id, issued.appliedId));
      if (problem === "row scope") await owned.db.update(workflowTransitionEvents).set({ issueId: f.qa.issueId }).where(eq(workflowTransitionEvents.id, issued.appliedId));
      if (problem === "followup") await owned.db.update(workflowTransitionEvents).set({ payload: { ...issued.followup, appliedEventId: randomUUID() } }).where(eq(workflowTransitionEvents.id, issued.followupId));
      if (problem === "before hash") {
        const payload = structuredClone(issued.applied); payload.revisions[0]!.files[0]!.beforeSha256 = "ff".repeat(32);
        await owned.db.update(workflowTransitionEvents).set({ payload }).where(eq(workflowTransitionEvents.id, issued.appliedId));
      }
      if (problem === "binding") await owned.db.update(workflowStepOutputBindings).set({ workProductId: f.productId }).where(eq(workflowStepOutputBindings.id, f.bindingId));
      if (problem === "B registration") await owned.db.update(issueWorkProducts).set({ issueId: f.qa.issueId! }).where(eq(issueWorkProducts.id, issued.workProductId));
      await expect(readIssuedQaCorrection(owned.db, issued.scope)).rejects.toThrow();
    });

  it("rejects a metadata-only B and a severed prior correction chain", async () => {
    const f = await seedQaCorrection(owned.db), absent = randomUUID();
    await owned.db.update(issueWorkProducts).set({ metadata: { path: f.remediations.items[0]!.file,
      qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1", appliedEventId: absent, revisionId: randomUUID() } } })
      .where(eq(issueWorkProducts.id, f.productId));
    f.preparation.sources[0]!.provenance = { kind: "prior_correction", appliedEventId: absent };
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
    await expect(readIssuedQaCorrection(owned.db, { companyId: f.preparation.companyId,
      workflowRunId: f.preparation.workflowRunId, appliedEventId: absent })).rejects.toThrow();
  });

  it("validates real quality SourceAttempt/action and rejects foreign action, hash and epoch", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).resolves.toMatchObject({ status: "authority_validated" });
    const authority = f.preparation.authority;
    if (authority.kind !== "quality_current_output") throw new Error("fixture authority");
    for (const patch of [{ actionId: f.quality!.actionId }, { targetHash: "ff".repeat(32) }, { verifierEpoch: authority.verifierEpoch + 1 }]) {
      const invalid = { ...f.preparation, authority: { ...authority, ...patch } };
      await expect(validateQaCorrectionAuthority(owned.db, invalid)).rejects.toThrow();
    }
    const issued = await issueQaCorrectionFixture(owned.db, f);
    await owned.db.update(qualityPolicyVersions).set({ disabledAt: new Date(Date.parse(issued.applied.appliedAt) + 1000) })
      .where(eq(qualityPolicyVersions.id, authority.policyVersionId));
    expect((await readIssuedQaCorrection(owned.db, issued.scope)).applied.qualityUseEvidenceRefId).toBe(issued.applied.qualityUseEvidenceRefId);
    await owned.db.update(qualityEvidenceRefs).set({ qualityActionId: f.quality!.actionId })
      .where(eq(qualityEvidenceRefs.id, issued.applied.qualityUseEvidenceRefId!));
    await expect(readIssuedQaCorrection(owned.db, issued.scope)).rejects.toThrow();
  });

  it("rejects changed source epoch and cancelled action without granting usage", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    const authority = f.preparation.authority;
    if (authority.kind !== "quality_current_output") throw new Error("fixture authority");
    await owned.db.update(heartbeatRuns).set({ executionEpoch: 2 }).where(eq(heartbeatRuns.id, f.producerHeartbeatId));
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
    await owned.db.update(heartbeatRuns).set({ executionEpoch: 1 }).where(eq(heartbeatRuns.id, f.producerHeartbeatId));
    await owned.db.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, authority.actionId));
    await expect(validateQaCorrectionAuthority(owned.db, f.preparation)).rejects.toThrow();
  });

  it("accepts real Db and transaction SELECT callers and leaves events unchanged", async () => {
    const f = await seedQaCorrection(owned.db), second = owned.connect();
    const before = await owned.db.select().from(workflowTransitionEvents);
    await second.transaction(async tx => {
      expect((await validateQaCorrectionAuthority(tx, f.preparation)).preparation.correctionId).toBe(f.preparation.correctionId);
    });
    expect(await owned.db.select().from(workflowTransitionEvents)).toEqual(before);
    expect(hashQaCorrectionPayload(f.remediations.items)).toBe(f.preparation.authority.verdicts[0]!.remediationsHash);
  });
});
