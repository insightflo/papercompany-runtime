import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, assets, issueAttachments, qualityActions, qualityEvidenceRefs, type Db } from "@paperclipai/db";
import { describeQualityDb } from "./helpers/quality-db.js";
import { createQaCorrectionTestDb, seedQaCorrection, type CorrectionFixture } from "./helpers/qa-correction-fixture.js";
import { getStorageService } from "../storage/index.js";
import { uploadEvidence } from "../services/quality/evidence-store.js";
import { hashContract, type QualityTx } from "../services/quality/contract.js";
import * as verifier from "../services/quality/evidence-verifier.js";
import { discardQaCorrectionUseEvidence, encodeQaCorrectionUseEvidence, prepareQaCorrectionUseEvidence,
  linkPreparedQaCorrectionUseEvidence, type PreparedQaCorrectionUseEvidence,
  type QaCorrectionUseEvidenceBinding as Binding } from "../services/quality/qa-correction-use-evidence.js";
import { hashQaCorrectionPayload, type QaCorrectionSourceMeasured } from "../services/workflow/control-flow/qa-correction-contract.js";

// C03 adopted §§3–4: identity-only, single-use token; mismatch/rollback never restore it.
// Expected failures come from that accepted lifetime/attribution contract, not a changed test oracle.
describeQualityDb("QA correction evidence token lifetime", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, other: Db;
  let fixture: CorrectionFixture, root: string, expiresAt: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "qa-use-token-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQaCorrectionTestDb(); other = owned.connect();
    fixture = await seedQaCorrection(owned.db, "sealed", true);
    if (fixture.preparation.authority.kind !== "quality_current_output") throw new Error("quality fixture");
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, fixture.preparation.authority.actionId));
    expiresAt = action.retryEnvelope.deadlineAt;
  }, 120_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    try { await owned?.close(); } finally { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true }); }
  }, 120_000);
  function binding(): Binding {
    const p = structuredClone(fixture.preparation), a = p.authority;
    if (a.kind !== "quality_current_output") throw new Error("quality fixture");
    const preparationHash = hashQaCorrectionPayload(p);
    const sourceMeasured: QaCorrectionSourceMeasured = {
      schemaVersion: "workflow.qa-correction.source-measured.v1", preparationEventId: p.correctionId, preparationHash,
      measuredAt: p.preparedAt, sources: [{ productId: fixture.productId,
        files: [{ role: "main", relativePath: "report.html", sha256: "10".repeat(32), byteSize: 3 }] }],
    };
    const revisions: Binding["revisions"] = [{ revisionId: randomUUID(), sourceProductId: fixture.productId,
      workProductId: randomUUID(), root: path.join(root, "candidate"), mainRelativePath: "report.html",
      bundleManifestRelativePath: null, assetsRelativeRoot: null,
      files: [{ role: "main", relativePath: "report.html", beforeSha256: "10".repeat(32), sha256: "20".repeat(32), byteSize: 3 }] }];
    return { schemaVersion: "workflow.qa-correction.use-evidence.v1", kind: "use", issuedBy: "quality:current-output",
      originalRef: null, companyId: p.companyId, correctionId: p.correctionId, appliedEventId: randomUUID(),
      preparation: p, preparationEventId: p.correctionId, preparationHash, sourceMeasuredEventId: randomUUID(),
      sourceMeasuredHash: hashQaCorrectionPayload(sourceMeasured), sourceMeasured, revisions,
      reviewItemId: a.reviewItemId, actionId: a.actionId, source: a.source,
      scope: { kind: "output_correction", companyId: p.companyId, actionId: a.actionId, source: a.source,
        verifierRunId: a.verifierRunId, verifierEpoch: a.verifierEpoch },
      expiresAt, beforeHash: hashQaCorrectionPayload(sourceMeasured.sources), revisionHash: hashQaCorrectionPayload(revisions) };
  }
  function rehash(b: Binding) {
    b.preparationHash = hashQaCorrectionPayload(b.preparation);
    b.sourceMeasured.preparationHash = b.preparationHash;
    b.sourceMeasuredHash = hashQaCorrectionPayload(b.sourceMeasured);
    b.beforeHash = hashQaCorrectionPayload(b.sourceMeasured.sources);
    b.revisionHash = hashQaCorrectionPayload(b.revisions);
  }
  async function upload(b: Binding) {
    return uploadEvidence(getStorageService(), { companyId: b.companyId, body: encodeQaCorrectionUseEvidence(b),
      contentType: "application/json", originalFilename: "qa-use.json" });
  }
  async function prepare(b = binding()) {
    const uploaded = await upload(b), token = await prepareQaCorrectionUseEvidence({ binding: b, uploaded });
    return { b, uploaded, token };
  }
  const link = (token: PreparedQaCorrectionUseEvidence, expected: Binding, db = owned.db) =>
    db.transaction(tx => linkPreparedQaCorrectionUseEvidence(tx, { token, expected }));
  async function state() {
    const id = fixture.preparation.companyId;
    return {
      assets: await owned.db.select().from(assets).where(eq(assets.companyId, id)).orderBy(assets.id),
      attachments: await owned.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, id)).orderBy(issueAttachments.id),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, id)).orderBy(qualityEvidenceRefs.id),
      audits: await owned.db.select().from(activityLog).where(eq(activityLog.companyId, id)).orderBy(activityLog.id),
    };
  }
  it.each(["cast", "copy", "serialized", "prototype"] as const)("rejects %s forgery without consuming the real token", async kind => {
    const { b, token } = await prepare();
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    const fake = (kind === "copy" ? structuredClone(token) : kind === "serialized" ? JSON.parse(JSON.stringify(token))
      : kind === "prototype" ? Object.create(token) : {}) as PreparedQaCorrectionUseEvidence;
    const before = await state();
    await expect(link(fake, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    expect(await state()).toEqual(before);
    await expect(link(token, b)).resolves.toHaveProperty("evidenceRefId");
  });
  const mutations: Record<string, (b: Binding) => void> = {
    company: b => { b.companyId = fixture.otherCompanyId; },
    correction: b => { b.correctionId = randomUUID(); },
    applied: b => { b.appliedEventId = randomUUID(); },
    preparationId: b => { b.preparationEventId = randomUUID(); },
    preparationHash: b => { b.preparationHash = "01".repeat(32); },
    authority: b => { b.preparation.authority.verdicts[0]!.remediationsHash = "02".repeat(32); },
    measurementId: b => { b.sourceMeasuredEventId = randomUUID(); },
    measurementHash: b => { b.sourceMeasuredHash = "03".repeat(32); },
    measurementBody: b => { b.sourceMeasured.sources[0]!.files[0]!.byteSize++; },
    revision: b => { b.revisions[0]!.revisionId = randomUUID(); },
    root: b => { b.revisions[0]!.root += "/other"; },
    format: b => { b.revisions[0]!.assetsRelativeRoot = "assets"; },
    fileBefore: b => { b.revisions[0]!.files[0]!.beforeSha256 = "04".repeat(32); },
    fileAfter: b => { b.revisions[0]!.files[0]!.sha256 = "05".repeat(32); },
    beforeHash: b => { b.beforeHash = "06".repeat(32); },
    revisionHash: b => { b.revisionHash = "07".repeat(32); },
    review: b => { b.reviewItemId = randomUUID(); },
    action: b => { b.actionId = randomUUID(); },
    source: b => { b.source.inputHash = "08".repeat(32); },
    scope: b => { b.scope.companyId = fixture.otherCompanyId; },
    verifier: b => { b.scope.verifierRunId = randomUUID(); },
    epoch: b => { b.scope.verifierEpoch++; },
    expiry: b => { b.expiresAt = new Date(Date.parse(b.expiresAt) + 1).toISOString(); },
  };
  it.each(Object.keys(mutations))("binds %s and burns a mismatched token before writing", async field => {
    const { b, token } = await prepare(), changed = structuredClone(b);
    mutations[field]!(changed);
    if (!["preparationHash", "measurementHash", "beforeHash", "revisionHash"].includes(field)) rehash(changed);
    const before = await state();
    await expect(link(token, changed)).rejects.toMatchObject({ status: 422 });
    await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    expect(await state()).toEqual(before);
  });
  it.each(["kind", "issuedBy", "originalRef", "scope", "missingFormat", "missingManifest", "extra", "accessor"] as const)(
    "rejects %s before reading storage", async fault => {
      const b = binding(), uploaded = await upload(b);
      if (fault === "kind") Object.assign(b, { kind: "input" });
      if (fault === "issuedBy") Object.assign(b, { issuedBy: "caller" });
      if (fault === "originalRef") Object.assign(b, { originalRef: { attachmentId: randomUUID(), sha256: "aa".repeat(32) } });
      if (fault === "scope") Object.assign(b, { scope: { kind: "plan_qa" } });
      if (fault === "missingFormat") delete (b.revisions[0]! as Partial<Binding["revisions"][number]>).assetsRelativeRoot;
      if (fault === "missingManifest") delete (b.revisions[0]! as Partial<Binding["revisions"][number]>).bundleManifestRelativePath;
      if (fault === "extra") Object.assign(b, { unregistered: true });
      if (fault === "accessor") Object.defineProperty(b.source, "inputHash", { enumerable: true, get: () => "aa".repeat(32) });
      const spy = vi.spyOn(getStorageService(), "getObject");
      await expect(prepareQaCorrectionUseEvidence({ binding: b, uploaded })).rejects.toMatchObject({ status: 422 });
      expect(spy).not.toHaveBeenCalled();
    });
  it("rejects a different valid same-company action scope, even after all its payload hashes are updated", async () => {
    const { b, token } = await prepare(), changed = structuredClone(b);
    const [old] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, b.actionId));
    const id = randomUUID(), intentKey = "other-" + id, retryEnvelope = { ...old.retryEnvelope, intentKey };
    await owned.db.insert(qualityActions).values({ ...old, id, intentKey, retryEnvelope,
      canonicalBinding: { ...old.canonicalBinding!, actionId: id } });
    const a = changed.preparation.authority;
    if (a.kind !== "quality_current_output") throw new Error("quality fixture");
    a.actionId = id; a.intentKey = intentKey; a.retryEnvelopeHash = hashContract(retryEnvelope);
    changed.actionId = id; changed.scope.actionId = id; rehash(changed);
    await verifier.verifyEvidenceScope(owned.db, changed.companyId, changed.scope);
    encodeQaCorrectionUseEvidence(changed);
    const before = await state();
    await expect(link(token, changed)).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
    expect(await state()).toEqual(before);
  });
  it("admits exactly one of two simultaneous consumers on independent real DB connections", async () => {
    const { b, token } = await prepare(), before = await state();
    const results = await Promise.allSettled([link(token, b), link(token, b, other)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ message: "quality_evidence_token_invalid" });
    const after = await state();
    for (const key of ["assets", "attachments", "receipts", "audits"] as const) expect(after[key]).toHaveLength(before[key].length + 1);
  });
  it.each(["caller", "database"] as const)("rolls back all four real writes on %s failure and requires fresh prepare", async fault => {
    const { b, token, uploaded } = await prepare(), before = await state();
    let linkedAll = false;
    await expect(owned.db.transaction(async tx => {
      await linkPreparedQaCorrectionUseEvidence(tx, { token, expected: b });
      linkedAll = true;
      if (fault === "database") await tx.execute(sql.raw("SELECT 1 / 0"));
      throw new Error("caller rollback");
    })).rejects.toThrow();
    expect(linkedAll).toBe(true);
    expect(await state()).toEqual(before);
    await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    const fresh = await prepareQaCorrectionUseEvidence({ binding: b, uploaded });
    await expect(link(fresh, b)).resolves.toHaveProperty("evidenceRefId");
  });
  it("rejects a Db masquerading as a transaction and burns its token", async () => {
    const { b, token } = await prepare(), before = await state();
    await expect(linkPreparedQaCorrectionUseEvidence(owned.db as unknown as QualityTx, { token, expected: b }))
      .rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    expect(await state()).toEqual(before);
  });
  it("makes discard irreversible and idempotent; a newly prepared token can retry the same upload", async () => {
    const { b, token, uploaded } = await prepare(), before = await state();
    discardQaCorrectionUseEvidence(token); discardQaCorrectionUseEvidence(token);
    await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    expect(await state()).toEqual(before);
    await expect(link(await prepareQaCorrectionUseEvidence({ binding: b, uploaded }), b)).resolves.toHaveProperty("evidenceRefId");
  });
  it("isolates nested expected input changed while an actual DB verifier awaits", async () => {
    const { b, token } = await prepare(), expected = structuredClone(b);
    const real = verifier.verifySourceAttempt;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(verifier, "verifySourceAttempt").mockImplementationOnce(async (...args) => {
      enter(); await gate; return real(...args);
    });
    const pending = link(token, expected);
    await entered;
    try { expected.source.inputHash = "ff".repeat(32); expected.revisions[0]!.files[0]!.sha256 = "ee".repeat(32); }
    finally { release(); }
    const linked = await pending; spy.mockRestore();
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, linked.evidenceRefId));
    expect(receipt.qualityContract?.source).toEqual(b.source);
  });
  it.each([false, true])("samples verifiedAt after awaited DB verification, expired=%s", async expired => {
    const b = binding(), uploaded = await upload(b), at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const token = await prepareQaCorrectionUseEvidence({ binding: b, uploaded }), before = await state();
    const later = expired ? Date.parse(b.expiresAt) : at + 250, real = verifier.verifyEvidenceScope;
    vi.spyOn(verifier, "verifyEvidenceScope").mockImplementationOnce(async (...args) => {
      await real(...args); clock.mockReturnValue(later);
    });
    if (expired) {
      await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_expired" });
      expect(await state()).toEqual(before);
    } else expect((await link(token, b)).verifiedAt).toBe(new Date(later).toISOString());
  });
  it.each(["measurement_future", "byte_clock_back", "expiry_boundary", "equal_bounds"] as const)(
    "enforces server time at %s after DB link checks", async fault => {
      const b = binding(), at = Date.now() + 10_000;
      b.sourceMeasured.measuredAt = new Date(fault === "measurement_future" ? at + 1
        : fault === "byte_clock_back" ? at - 1_000 : at).toISOString();
      rehash(b);
      const uploaded = await upload(b), clock = vi.spyOn(Date, "now").mockReturnValue(at);
      const token = await prepareQaCorrectionUseEvidence({ binding: b, uploaded }), before = await state();
      if (fault === "byte_clock_back") clock.mockReturnValue(at - 1);
      if (fault === "expiry_boundary") clock.mockReturnValue(Date.parse(b.expiresAt));
      if (fault === "equal_bounds") {
        const result = await link(token, b);
        expect(result.verifiedAt).toBe(new Date(at).toISOString());
      } else {
        await expect(link(token, b)).rejects.toMatchObject({ message: fault === "expiry_boundary"
          ? "quality_evidence_expired" : "quality_evidence_time_reversed" });
        expect(await state()).toEqual(before);
        await expect(link(token, b)).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
      }
    });
});
