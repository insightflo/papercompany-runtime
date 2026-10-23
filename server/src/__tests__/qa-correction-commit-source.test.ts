import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueWorkProducts, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources, readMeasuredQaCorrection, type MeasuredRef } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { observeQaCorrectionSources, readQaCorrectionSourceBytes, qaCorrectionSourceFacts } from "../services/workflow/control-flow/qa-correction-source-bytes.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import * as artifactFiles from "../services/workflow/artifact-files.js";
import { changeCommitRequest, changeCommitSelector, commitBuffers, commitDbState, commitFacts, commitFileState,
  createCommitSourceHarness, hideCommitDeclaration, makeCommitPrior, makeCommitSource, type CommitSourceCase, type CommitSourceMode } from "./qa-correction-commit-fixture.js";

describe("C03 accepted plan sections 2/8: common prior observation and fixed measurement reads", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => { owned = await createCommitSourceHarness(); }, 120000);
  afterAll(async () => { await owned?.close(); }, 120000);
  async function original(mode: CommitSourceMode = "html", legacy = false, quality = false) {
    return makeCommitSource(owned.db, owned.root, mode, legacy, quality);
  }
  async function prepare(s: CommitSourceCase) {
    const result = await beginQaCorrection(owned.db, s.p);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw Error("actual preparation required: " + result.status);
    return result;
  }
  async function observe(s: CommitSourceCase, p = s.p) {
    const observed = await observeQaCorrectionSources(owned.db, p);
    const bytes = await readQaCorrectionSourceBytes(p, observed);
    return { observed, bytes };
  }
  async function measured(s: CommitSourceCase) {
    const prepared = await prepare(s), proof = {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash };
    const { observed, bytes } = await observe(s, prepared.preparation);
    expect(qaCorrectionSourceFacts(bytes)).toEqual([{ productId: s.productId, files: commitFacts(s.files) }]);
    const ref = await measureQaCorrectionSources(owned.db, proof);
    expect(ref.sourceMeasured.sources).toEqual([{ productId: s.productId, files: commitFacts(s.files) }]);
    return { prepared, proof, ref, observed, bytes };
  }
  // These expectations come from independently authored input bytes and the historical issuance contract.
  // The external fixed probe remains unchanged: before A PASS/B FAIL, after A PASS/B PASS.
  it("preserves the sealed workflow-producer A control through actual begin/measure/store", async () => {
    const s = await original(), files = await commitFileState(s), m = await measured(s);
    const before = await commitDbState(s), stored = await storeQaCorrection(owned.db, m.ref);
    expect(stored.status).toBe("stored_uncommitted");
    expect([...stored.revisions[0]!.files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
      .toEqual(commitFacts(commitBuffers("html", "new")).map(f => ({
      ...f, beforeSha256: artifactFiles.digest(s.files.get(f.relativePath)!) })));
    for (const [relative, bytes] of commitBuffers("html", "new")) {
      expect(await readFile(path.join(stored.revisions[0]!.root, relative))).toEqual(bytes);
    }
    expect(await commitDbState(s)).toEqual(before);
    expect(await commitFileState(s)).toEqual(files);
  }, 20000);
  it.each(["html", "content", "empty", "content-only"] as const)(
    "reaches actual begin/observe/bytes/measure for issued %s without losing any tuple", async mode => {
      const source = await original(mode), s = await makeCommitPrior(source), files = await commitFileState(s);
      expect(s.f.qa.id).not.toBe(source.f.qa.id);
      expect(s.f.qa.issueId).not.toBe(source.f.qa.issueId);
      expect(s.request.stepRunId).toBe(s.f.qa.id);
      expect(s.request.input.workProductId).toBe(s.history!.workProductId);
      const issued = await readIssuedQaCorrection(owned.db, s.history!.scope), m = await measured(s);
      const revision = issued.applied.revisions[0]!;
      expect(m.ref.sourceMeasured.sources[0]!.files).toEqual(revision.files.map(({ beforeSha256: _, ...f }) => f));
      expect(m.observed.priors[0]!.revision).toEqual(revision);
      expect(m.observed.priors[0]!.workflowProducer).toEqual(s.producer);
      expect(s.request.input.producer.sha256).toBe(artifactFiles.digest(commitBuffers(mode, "old").get("report.html")!));
      expect(s.request.input.sha256).toBe(artifactFiles.digest(s.files.get("report.html")!));
      expect(s.request.input.sha256).not.toBe(s.request.input.producer.sha256);
      expect(s.request.input.assetsRoot).toBe(mode === "html" || mode === "content-only" ? "" : path.join(revision.root, "assets"));
      expect(m.bytes[0]!.assetsRoot).toBe(mode === "content-only" ? null : path.join(revision.root, "assets"));
      expect(m.ref.sourceMeasured.sources[0]!.files.filter(f => f.role === "asset")).toHaveLength(mode === "html" ? 1 : mode === "content" ? 9 : 0);
      const before = await commitDbState(s);
      expect(await measureQaCorrectionSources(owned.db, m.proof)).toEqual(m.ref);
      expect(await commitDbState(s)).toEqual(before);
      expect(await commitFileState(s)).toEqual(files);
    }, 20000);
  it("follows two actual historical issuance edges to the complete original sealed producer", async () => {
    const first = await makeCommitPrior(await original("content-only"));
    const s = await makeCommitPrior(first), files = await commitFileState(s), m = await measured(s);
    expect(m.observed.priors[0]!.workflowProducer).toEqual(s.producer);
    expect(s.request.input.producer.sha256).toBe(artifactFiles.digest(commitBuffers("content-only", "old").get("report.html")!));
    expect(s.request.input.sha256).toBe(artifactFiles.digest(commitBuffers("content-only", "final").get("report.html")!));
    expect(await commitFileState(s)).toEqual(files);
  }, 20000);

  const faults = ["prior_id", "pointer_revision", "issued_root", "issued_main", "manifest_undefined", "assets_undefined",
    "manifest_path", "assets_path", "issued_hash", "issued_size", "omitted_asset", "producer_heartbeat", "producer_seal",
    "producer_generation", "pin", "selector_type", "selector_title", "qa_generation", "qa_retry", "qa_iteration",
    "request_id", "request_attempt", "request_root", "input_product", "input_path", "input_hash", "input_size", "html_assets"] as const;
  it.each(faults)("rejects %s after a proven valid prior, preserving A/B files", async fault => {
    const s = await makeCommitPrior(await original()), files = await commitFileState(s), m = await measured(s);
    const p = structuredClone(m.prepared.preparation), issued = structuredClone(s.history!);
    const revision = issued.applied.revisions[0]!;
    if (fault === "prior_id") p.sources[0]!.provenance = { kind: "prior_correction", appliedEventId: randomUUID() };
    if (fault === "pointer_revision") {
      const [b] = await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, s.productId));
      await owned.db.update(issueWorkProducts).set({ metadata: { ...b!.metadata,
        qaCorrection: { ...b!.metadata.qaCorrection as object, revisionId: randomUUID() } } }).where(eq(issueWorkProducts.id, s.productId));
    }
    if (fault === "issued_root") revision.root += "/wrong";
    if (fault === "issued_main") revision.mainRelativePath = "wrong.html";
    if (fault === "manifest_undefined") delete revision.bundleManifestRelativePath;
    if (fault === "assets_undefined") delete revision.assetsRelativeRoot;
    if (fault === "manifest_path") revision.bundleManifestRelativePath = "source-notes.txt";
    if (fault === "assets_path") await changeCommitRequest(s, r => { r.input.assetsRoot = path.join(s.directory, "assets"); });
    if (fault === "issued_hash") revision.files.find(f => f.role === "main")!.sha256 = "ff".repeat(32);
    if (fault === "issued_size") revision.files.find(f => f.role === "main")!.byteSize++;
    if (fault === "omitted_asset") {
      // Keep structural issuance links valid; only exact declaration-vs-issued-set comparison can accept/reject the omission.
      revision.files = revision.files.filter(f => f.role !== "asset");
      issued.measured.sources[0]!.files = issued.measured.sources[0]!.files.filter(f => f.role !== "asset");
      issued.applied.sourceMeasuredHash = hashQaCorrectionPayload(issued.measured);
      await owned.db.update(workflowTransitionEvents).set({ payload: issued.measured }).where(eq(workflowTransitionEvents.id, issued.measuredId));
    }
    if (["issued_root", "issued_main", "manifest_undefined", "assets_undefined", "manifest_path", "issued_hash", "issued_size", "omitted_asset"].includes(fault)) {
      await owned.db.update(workflowTransitionEvents).set({ payload: issued.applied }).where(eq(workflowTransitionEvents.id, issued.appliedId));
    }
    if (fault === "producer_heartbeat") await changeCommitRequest(s, r => { r.input.producer.heartbeatRunId = randomUUID(); });
    if (fault === "producer_seal") await changeCommitRequest(s, r => { r.input.producer.sha256 = r.input.sha256; r.input.producer.byteSize = r.input.byteSize; });
    if (fault === "producer_generation") await changeCommitRequest(s, r => { r.input.producer.executionGeneration++; });
    if (fault === "pin") await owned.db.update(workflowStepOutputBindings).set({ workProductId: s.f.productId }).where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    if (fault === "selector_type" || fault === "selector_title") await changeCommitSelector(s,
      { type: fault === "selector_type" ? "file" : "artifact", title: fault === "selector_title" ? "other" : "report" });
    if (fault === "qa_generation" || fault === "qa_retry" || fault === "qa_iteration") await owned.db.update(workflowStepRuns)
      .set(fault === "qa_generation" ? { executionGeneration: s.f.qa.executionGeneration + 1 }
        : fault === "qa_retry" ? { retryCount: s.f.qa.retryCount + 1 } : { iterationIndex: s.f.qa.iterationIndex + 1 })
      .where(eq(workflowStepRuns.id, s.f.qa.id));
    if (fault === "request_id") await changeCommitRequest(s, r => { r.requestId = randomUUID(); });
    if (fault === "request_attempt") await changeCommitRequest(s, r => { r.iterationIndex = s.f.qa.iterationIndex + 1; });
    if (fault === "request_root") await changeCommitRequest(s, r => { r.outputRootHash = "ff".repeat(32); });
    if (fault === "input_product") await changeCommitRequest(s, r => { r.input.workProductId = randomUUID(); });
    if (fault === "input_path") await changeCommitRequest(s, r => { r.input.path = s.file + ".wrong"; });
    if (fault === "input_hash") await changeCommitRequest(s, r => { r.input.sha256 = "ff".repeat(32); });
    if (fault === "input_size") await changeCommitRequest(s, r => { r.input.byteSize++; });
    if (fault === "html_assets") await changeCommitRequest(s, r => { r.input.assetManifest = []; });
    const before = await commitDbState(s);
    await expect(observe(s, p)).rejects.toThrow();
    if (fault !== "prior_id") await expect(measureQaCorrectionSources(owned.db, m.proof)).rejects.toThrow();
    expect(await commitDbState(s)).toEqual(before);
    expect(await commitFileState(s)).toEqual(files);
  }, 20000);
  it.each(["empty", "content-only"] as const)("keeps issued null versus an explicit empty assets folder: %s", async mode => {
    const s = await makeCommitPrior(await original(mode)), files = await commitFileState(s), m = await measured(s);
    await changeCommitRequest(s, r => { r.input.assetsRoot = mode === "empty" ? "" : path.join(s.directory, "assets"); });
    const before = await commitDbState(s);
    await expect(observe(s, m.prepared.preparation)).rejects.toThrow();
    await expect(measureQaCorrectionSources(owned.db, m.proof)).rejects.toThrow();
    expect(await commitDbState(s)).toEqual(before); expect(await commitFileState(s)).toEqual(files);
  }, 20000);
  it("never promotes a registered-legacy ancestor with a fabricated producer, while retaining undeclared history", async () => {
    const s = await makeCommitPrior(await original("content-only", true)), files = await commitFileState(s);
    const validHistory = await readIssuedQaCorrection(owned.db, s.history!.scope);
    expect(validHistory.sources[0]!.origin).toBe("registered_legacy");
    const restore = await hideCommitDeclaration(s);
    const applied = structuredClone(s.history!.applied);
    delete applied.revisions[0]!.bundleManifestRelativePath; delete applied.revisions[0]!.assetsRelativeRoot;
    await owned.db.update(workflowTransitionEvents).set({ payload: applied }).where(eq(workflowTransitionEvents.id, s.history!.appliedId));
    expect((await readIssuedQaCorrection(owned.db, s.history!.scope)).sources[0]!.origin).toBe("registered_legacy");
    const m = await measured(s); // Actual undeclared historical compatibility, including undefined format.
    await owned.db.update(workflowTransitionEvents).set({ payload: s.history!.applied }).where(eq(workflowTransitionEvents.id, s.history!.appliedId));
    await restore();
    const before = await commitDbState(s);
    await expect(observe(s, m.prepared.preparation)).rejects.toMatchObject({ reason: "source" });
    await expect(measureQaCorrectionSources(owned.db, m.proof)).rejects.toMatchObject({ reason: "source" });
    expect(await commitDbState(s)).toEqual(before); expect(await commitFileState(s)).toEqual(files);
  }, 20000);

  it("re-reads the same actual measurement using SELECT only, including a quality preparation and another connection", async () => {
    const s = await original("content-only", false, true), files = await commitFileState(s), m = await measured(s);
    const before = await commitDbState(s), spies = [vi.spyOn(owned.db, "insert"), vi.spyOn(owned.db, "update"),
      vi.spyOn(owned.db, "delete"), vi.spyOn(owned.db, "execute"), vi.spyOn(owned.db, "transaction"),
      vi.spyOn(artifactFiles, "readArtifactBytes"), vi.spyOn(artifactFiles, "captureArtifactRoot")];
    onTestFinished(() => { for (const spy of spies) spy.mockRestore(); });
    for (let i = 0; i < 2; i++) expect(await readMeasuredQaCorrection(owned.db, m.ref))
      .toEqual({ preparation: m.prepared.preparation, measured: m.ref });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await readMeasuredQaCorrection(owned.connect(), m.ref)).toEqual({ preparation: m.prepared.preparation, measured: m.ref });
    expect(await commitDbState(s)).toEqual(before); expect(await commitFileState(s)).toEqual(files);
  }, 20000);

  const readerFaults = ["preparation_id", "preparation_hash", "measurement_id", "measurement_hash", "expected_body",
    "preparation_row_id", "preparation_payload_hash", "measurement_row_id", "measurement_before_time",
    "preparation_type", "preparation_layer", "preparation_scope", "preparation_time", "preparation_body", "reservation_key",
    "measurement_type", "measurement_layer", "measurement_company", "measurement_mission", "measurement_run",
    "measurement_step", "measurement_issue", "measurement_generation", "measurement_key", "measurement_time",
    "measurement_body", "measurement_preparation", "measurement_products"] as const;
  it.each(readerFaults)("rejects measured reference/row tampering: %s", async fault => {
    const s = await original("content-only"), files = await commitFileState(s), m = await measured(s);
    expect(await readMeasuredQaCorrection(owned.db, m.ref)).toEqual({ preparation: m.prepared.preparation, measured: m.ref });
    const ref: MeasuredRef = structuredClone(m.ref);
    if (fault === "preparation_id") ref.preparationEventId = randomUUID();
    if (fault === "preparation_hash") ref.preparationHash = "ff".repeat(32);
    if (fault === "measurement_id") ref.sourceMeasuredEventId = randomUUID();
    if (fault === "measurement_hash") ref.sourceMeasuredHash = "ff".repeat(32);
    if (fault === "expected_body") ref.sourceMeasured.sources[0]!.files[0]!.sha256 = "ff".repeat(32);
    if (fault === "preparation_row_id" || fault === "measurement_row_id") await owned.db.update(workflowTransitionEvents)
      .set({ id: randomUUID() }).where(eq(workflowTransitionEvents.id,
        fault === "preparation_row_id" ? m.ref.preparationEventId : m.ref.sourceMeasuredEventId));
    if (fault === "preparation_payload_hash") {
      const body = structuredClone(m.prepared.preparation), source = body.sources[0]!.provenance;
      if (source.kind !== "workflow_producer") throw Error("sealed source required");
      source.workflowProducer.sha256 = "ff".repeat(32);
      await owned.db.update(workflowTransitionEvents).set({ payload: body }).where(eq(workflowTransitionEvents.id, m.ref.preparationEventId));
    }
    if (fault === "measurement_before_time") {
      ref.sourceMeasured.measuredAt = new Date(Date.parse(m.prepared.preparation.preparedAt) - 1).toISOString();
      ref.sourceMeasuredHash = hashQaCorrectionPayload(ref.sourceMeasured);
      await owned.db.update(workflowTransitionEvents).set({ payload: ref.sourceMeasured, createdAt: new Date(ref.sourceMeasured.measuredAt) })
        .where(eq(workflowTransitionEvents.id, m.ref.sourceMeasuredEventId));
    }
    if (["preparation_type", "preparation_layer", "preparation_scope", "preparation_time", "preparation_body"].includes(fault)) {
      await owned.db.update(workflowTransitionEvents).set(fault === "preparation_type" ? { eventType: "wrong" }
        : fault === "preparation_layer" ? { layer: "wrong" } : fault === "preparation_scope" ? { missionId: null }
        : fault === "preparation_time" ? { createdAt: new Date(0) }
        : { payload: { ...m.prepared.preparation, preparedAt: new Date(0).toISOString() } })
        .where(eq(workflowTransitionEvents.id, m.prepared.preparationEventId));
    }
    if (fault === "reservation_key") await owned.db.update(workflowTransitionEvents).set({ idempotencyKey: "wrong" })
      .where(eq(workflowTransitionEvents.id, m.prepared.preparationEventId));
    const patch = fault === "measurement_type" ? { eventType: "wrong" } : fault === "measurement_layer" ? { layer: "wrong" }
      : fault === "measurement_company" ? { companyId: s.f.otherCompanyId } : fault === "measurement_mission" ? { missionId: null }
      : fault === "measurement_run" ? { workflowRunId: null } : fault === "measurement_step" ? { workflowStepRunId: null }
      : fault === "measurement_issue" ? { issueId: null } : fault === "measurement_generation" ? { executionGeneration: 1 }
      : fault === "measurement_key" ? { idempotencyKey: "wrong" } : fault === "measurement_time" ? { createdAt: new Date(0) } : null;
    if (patch) await owned.db.update(workflowTransitionEvents).set(patch).where(eq(workflowTransitionEvents.id, m.ref.sourceMeasuredEventId));
    if (fault === "measurement_body" || fault === "measurement_preparation" || fault === "measurement_products") {
      const body = structuredClone(m.ref.sourceMeasured);
      if (fault === "measurement_body") body.sources[0]!.files[0]!.sha256 = "ff".repeat(32);
      if (fault === "measurement_preparation") body.preparationEventId = randomUUID();
      if (fault === "measurement_products") {
        body.sources[0]!.productId = randomUUID(); ref.sourceMeasured = body; ref.sourceMeasuredHash = hashQaCorrectionPayload(body);
      }
      await owned.db.update(workflowTransitionEvents).set({ payload: body }).where(eq(workflowTransitionEvents.id, m.ref.sourceMeasuredEventId));
    }
    const before = await commitDbState(s);
    await expect(readMeasuredQaCorrection(owned.db, ref)).rejects.toMatchObject({ reason: "record" });
    expect(await commitDbState(s)).toEqual(before); expect(await commitFileState(s)).toEqual(files);
  }, 20000);
});
