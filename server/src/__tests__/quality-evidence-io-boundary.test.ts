import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as files } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, assets, heartbeatRuns, issueAttachments, qualityActions,
  qualityEvidenceRefs, qualityReviewItems } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQaCorrection, type CorrectionFixture } from "./helpers/qa-correction-fixture.js";
import { getStorageService } from "../storage/index.js";
import { linkEvidence, readEvidence, uploadEvidence } from "../services/quality/evidence-store.js";
import { encodeQaCorrectionUseEvidence, prepareQaCorrectionUseEvidence,
  linkPreparedQaCorrectionUseEvidence, type QaCorrectionUseEvidenceBinding } from "../services/quality/qa-correction-use-evidence.js";
import { hashQaCorrectionPayload, type QaCorrectionSourceMeasured } from "../services/workflow/control-flow/qa-correction-contract.js";

// C03 adopted plan §§3–4: real stored bytes before TX; four records commit or roll back together.
// C12: the existing non-null originalRef path must still re-read its original bytes.
// These fixture records exercise this API's links, not commit/current-authority/budget issuance.
describeQualityDb("QA correction evidence IO boundary", () => {
  let owned: QualityTestDb, fixture: CorrectionFixture, root: string, expiresAt: string;
  beforeAll(async () => {
    root = await files.mkdtemp(path.join(os.tmpdir(), "qa-use-io-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    fixture = await seedQaCorrection(owned.db, "sealed", true);
    if (fixture.preparation.authority.kind !== "quality_current_output") throw new Error("quality fixture");
    const [action] = await owned.db.select().from(qualityActions)
      .where(eq(qualityActions.id, fixture.preparation.authority.actionId));
    expiresAt = action.retryEnvelope.deadlineAt;
  }, 120_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    try { await owned?.close(); } finally {
      vi.unstubAllEnvs();
      if (root) await files.rm(root, { recursive: true });
    }
  }, 120_000);
  function binding(): QaCorrectionUseEvidenceBinding {
    const p = structuredClone(fixture.preparation), a = p.authority;
    if (a.kind !== "quality_current_output") throw new Error("quality fixture");
    const preparationHash = hashQaCorrectionPayload(p);
    const sourceMeasured: QaCorrectionSourceMeasured = {
      schemaVersion: "workflow.qa-correction.source-measured.v1",
      preparationEventId: p.correctionId, preparationHash, measuredAt: p.preparedAt,
      sources: [{ productId: fixture.productId,
        files: [{ role: "main", relativePath: "report.html", sha256: "10".repeat(32), byteSize: 3 }] }],
    };
    const revisions: QaCorrectionUseEvidenceBinding["revisions"] = [{
      revisionId: randomUUID(), sourceProductId: fixture.productId, workProductId: randomUUID(),
      root: path.join(root, "candidate"), mainRelativePath: "report.html",
      bundleManifestRelativePath: null, assetsRelativeRoot: null,
      files: [{ role: "main", relativePath: "report.html", beforeSha256: "10".repeat(32), sha256: "20".repeat(32), byteSize: 3 }],
    }];
    return { schemaVersion: "workflow.qa-correction.use-evidence.v1", kind: "use",
      issuedBy: "quality:current-output", originalRef: null, companyId: p.companyId,
      correctionId: p.correctionId, appliedEventId: randomUUID(), preparation: p,
      preparationEventId: p.correctionId, preparationHash, sourceMeasuredEventId: randomUUID(),
      sourceMeasuredHash: hashQaCorrectionPayload(sourceMeasured), sourceMeasured, revisions,
      actionId: a.actionId, reviewItemId: a.reviewItemId, source: a.source,
      scope: { kind: "output_correction", companyId: p.companyId, actionId: a.actionId,
        source: a.source, verifierRunId: a.verifierRunId, verifierEpoch: a.verifierEpoch },
      expiresAt, beforeHash: hashQaCorrectionPayload(sourceMeasured.sources), revisionHash: hashQaCorrectionPayload(revisions) };
  }
  async function upload(b: QaCorrectionUseEvidenceBinding, body = encodeQaCorrectionUseEvidence(b)) {
    return uploadEvidence(getStorageService(), { companyId: b.companyId, body,
      contentType: "application/json", originalFilename: "qa-use.json" });
  }
  async function state() {
    const companyId = fixture.preparation.companyId;
    return {
      assets: await owned.db.select().from(assets).where(eq(assets.companyId, companyId)).orderBy(assets.id),
      attachments: await owned.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, companyId)).orderBy(issueAttachments.id),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, companyId)).orderBy(qualityEvidenceRefs.id),
      audits: await owned.db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id),
    };
  }
  it("uploads and prepares before TX, links all four records with zero storage/FS calls, then reads the exact body", async () => {
    const b = binding(), body = encodeQaCorrectionUseEvidence(b), uploaded = await upload(b, body);
    const token = await prepareQaCorrectionUseEvidence({ binding: b, uploaded });
    const storage = getStorageService();
    const spies = [
      ...(["getObject", "putFile", "headObject", "deleteObject"] as const).map(name => vi.spyOn(storage, name)),
      ...(["readFile", "open", "stat", "lstat", "realpath", "readdir", "access", "writeFile", "mkdir", "rename", "chmod", "unlink"] as const)
        .map(name => vi.spyOn(files, name)),
      ...(["createReadStream", "readFileSync", "openSync", "statSync", "writeFileSync"] as const).map(name => vi.spyOn(fs, name)),
    ];
    let linked: Awaited<ReturnType<typeof linkPreparedQaCorrectionUseEvidence>>;
    try {
      linked = await owned.db.transaction(tx => linkPreparedQaCorrectionUseEvidence(tx, { token, expected: b }));
      expect(spies.map(spy => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    } finally { spies.forEach(spy => spy.mockRestore()); }
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, linked.evidenceRefId));
    const [attachment] = await owned.db.select().from(issueAttachments).where(eq(issueAttachments.id, linked.ref.attachmentId));
    const [asset] = await owned.db.select().from(assets).where(eq(assets.id, attachment.assetId));
    const audits = await owned.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, b.companyId), eq(activityLog.entityId, receipt.id)));
    expect(asset).toMatchObject({ companyId: b.companyId, ...uploaded });
    expect(attachment).toMatchObject({ companyId: b.companyId, issueId: b.source.issueId, assetId: asset.id });
    expect(receipt).toMatchObject({ companyId: b.companyId, reviewItemId: b.reviewItemId, qualityActionId: b.actionId,
      status: "verified", surface: "attachment", sourceRunId: b.source.heartbeatRunId,
      collectedByActorType: "system", collectedByActorId: b.issuedBy,
      qualityContract: { schemaVersion: 1, kind: "use", ref: linked.ref, source: b.source, scope: b.scope,
        issuedBy: b.issuedBy, originalRef: null, verifiedAt: linked.verifiedAt, expiresAt: b.expiresAt } });
    expect(receipt.freshnessExpiresAt?.toISOString()).toBe(b.expiresAt);
    expect(audits).toMatchObject([{ companyId: b.companyId, actorId: b.issuedBy, action: "quality.evidence_linked",
      entityType: "quality_evidence_ref", details: { attachmentId: linked.ref.attachmentId,
        reviewItemId: b.reviewItemId, correctionId: b.correctionId, appliedEventId: b.appliedEventId, kind: "use" } }]);
    expect(audits).toHaveLength(1);
    expect(await readEvidence(owned.db, { companyId: b.companyId, ref: linked.ref, scope: b.scope, maxBytes: body.length })).toEqual(body);
    expect(JSON.parse(body.toString("utf8"))).toEqual(b);
    expect(JSON.parse(body.toString()).source.inputHash).toBe("ab".repeat(32));
    expect(b.beforeHash).not.toBe(b.source.inputHash);
    expect(Date.parse(linked.verifiedAt)).toBeGreaterThanOrEqual(Date.parse(b.sourceMeasured.measuredAt));
  });
  it.each(["body", "bytes", "size", "hash", "provider", "foreign", "missing"] as const)(
    "rejects actual %s faults before any DB effect", async fault => {
      const b = binding(), expected = encodeQaCorrectionUseEvidence(b);
      const uploaded = await upload(b, fault === "body" ? Buffer.from("different complete body") : expected);
      if (fault === "bytes") await files.writeFile(path.join(root, uploaded.objectKey), Buffer.alloc(expected.length, 120));
      if (fault === "size") uploaded.byteSize--;
      if (fault === "hash") uploaded.sha256 = "00".repeat(32);
      if (fault === "provider") uploaded.provider = "s3";
      if (fault === "foreign") {
        const foreign = await uploadEvidence(getStorageService(), { companyId: fixture.otherCompanyId, body: expected,
          contentType: "application/json", originalFilename: null });
        uploaded.objectKey = foreign.objectKey;
      }
      if (fault === "missing") await files.unlink(path.join(root, uploaded.objectKey));
      const before = await state();
      await expect(prepareQaCorrectionUseEvidence({ binding: b, uploaded })).rejects.toMatchObject({ status: 422 });
      expect(await state()).toEqual(before);
    });
  it("copies nested binding and all six upload fields before its first await", async () => {
    const mutable = binding(), expected = structuredClone(mutable), uploaded = await upload(mutable);
    const savedUpload = { ...uploaded }, storage = getStorageService(), getObject = storage.getObject.bind(storage);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(storage, "getObject").mockImplementationOnce(async (...args) => {
      enter(); await gate; return getObject(...args);
    });
    const pending = prepareQaCorrectionUseEvidence({ binding: mutable, uploaded });
    await entered;
    try {
      mutable.source.inputHash = "cc".repeat(32);
      mutable.scope.verifierEpoch++;
      mutable.preparation.sources[0]!.provenance = { kind: "registered_legacy" };
      mutable.sourceMeasured.sources[0]!.files[0]!.sha256 = "dd".repeat(32);
      mutable.revisions[0]!.files[0]!.sha256 = "ee".repeat(32);
      Object.assign(uploaded, { provider: "s3", objectKey: fixture.otherCompanyId + "/foreign", byteSize: 1,
        sha256: "ff".repeat(32), contentType: "text/plain", originalFilename: "mutated.txt" });
    } finally { release(); }
    const token = await pending;
    spy.mockRestore();
    const linked = await owned.db.transaction(tx => linkPreparedQaCorrectionUseEvidence(tx, { token, expected }));
    const [attachment] = await owned.db.select().from(issueAttachments).where(eq(issueAttachments.id, linked.ref.attachmentId));
    const [asset] = await owned.db.select().from(assets).where(eq(assets.id, attachment.assetId));
    expect(asset).toMatchObject(savedUpload);
    expect(await readEvidence(owned.db, { companyId: expected.companyId, ref: linked.ref, scope: expected.scope,
      maxBytes: savedUpload.byteSize })).toEqual(encodeQaCorrectionUseEvidence(expected));
  });
  it.each(["review", "action", "occurrence", "source", "verifier", "canonical", "envelope"] as const)(
    "rejects the real DB %s mismatch and leaves all four record sets unchanged", async fault => {
      const b = binding(), uploaded = await upload(b), token = await prepareQaCorrectionUseEvidence({ binding: b, uploaded });
      const before = await state();
      await expect(owned.db.transaction(async tx => {
        const [action] = await tx.select().from(qualityActions).where(eq(qualityActions.id, b.actionId));
        if (fault === "review") await tx.delete(qualityReviewItems).where(eq(qualityReviewItems.id, b.reviewItemId));
        if (fault === "action") await tx.update(qualityActions).set({ kind: "qa_addendum" }).where(eq(qualityActions.id, b.actionId));
        if (fault === "occurrence") await tx.update(qualityActions).set({ occurrenceIds: [randomUUID()] }).where(eq(qualityActions.id, b.actionId));
        if (fault === "source") await tx.update(heartbeatRuns).set({ executionEpoch: 999 }).where(eq(heartbeatRuns.id, b.source.heartbeatRunId));
        if (fault === "verifier") await tx.update(heartbeatRuns).set({ executionEpoch: 999 }).where(eq(heartbeatRuns.id, b.scope.verifierRunId));
        if (fault === "canonical") await tx.update(qualityActions).set({
          canonicalBinding: { ...action.canonicalBinding!, stepRunId: randomUUID() },
        }).where(eq(qualityActions.id, b.actionId));
        if (fault === "envelope") await tx.update(qualityActions).set({
          retryEnvelope: { ...action.retryEnvelope, deadlineAt: new Date(Date.parse(b.expiresAt) + 1).toISOString() },
        }).where(eq(qualityActions.id, b.actionId));
        return linkPreparedQaCorrectionUseEvidence(tx, { token, expected: b });
      })).rejects.toMatchObject({ status: 422 });
      expect(await state()).toEqual(before);
    });
  it("preserves legacy originalRef success and original-byte revalidation on the same input", async () => {
    const b = binding(), originalUpload = await uploadEvidence(getStorageService(), { companyId: b.companyId,
      body: Buffer.from("legacy original"), contentType: "text/plain", originalFilename: "original.txt" });
    const original = await owned.db.transaction(tx => linkEvidence(tx, { companyId: b.companyId,
      reviewItemId: b.reviewItemId, source: b.source, scope: b.scope, kind: "input", uploaded: originalUpload,
      expiresAt: null, issuedBy: "legacy-test" }));
    const request = async () => {
      const uploaded = await uploadEvidence(getStorageService(), { companyId: b.companyId, body: Buffer.from("x"),
        contentType: "text/plain", originalFilename: "read.txt" });
      return owned.db.transaction(tx => linkEvidence(tx, { companyId: b.companyId, reviewItemId: b.reviewItemId,
        source: b.source, scope: b.scope, kind: "read", uploaded, expiresAt: null,
        issuedBy: "legacy-test", originalRef: original.ref }));
    };
    const linked = await request();
    expect(await readEvidence(owned.db, { companyId: b.companyId, ref: linked.ref, scope: b.scope, maxBytes: 1 })).toEqual(Buffer.from("x"));
    await files.writeFile(path.join(root, originalUpload.objectKey), "tamper original");
    const before = await state();
    await expect(request()).rejects.toMatchObject({ message: "quality_evidence_hash_mismatch" });
    expect(await state()).toEqual(before);
  });
});
