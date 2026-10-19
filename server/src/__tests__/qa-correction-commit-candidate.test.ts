import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import { assets, issueAttachments, qualityActions, qualityPolicyUsage,
  workflowStepOutputBindings, workflowTransitionEvents } from "@paperclipai/db";
import { getStorageService, type PutFileResult } from "../storage/index.js";
import * as artifactFiles from "../services/workflow/artifact-files.js";
import { readVerifiedEvidenceUpload } from "../services/quality/evidence-store.js";
import * as useEvidence from "../services/quality/qa-correction-use-evidence.js";
import { beginQaCorrection, withCurrentQaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection, type StoredCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { assertQaCorrectionCommitCurrent, qaCorrectionCommitDetails, rereadQaCorrectionCommitSources,
  validateQaCorrectionCommitCandidate } from "../services/workflow/control-flow/qa-correction-commit-validation.js";
import { prepareQaCorrectionCommitQualityUse } from "../services/workflow/control-flow/qa-correction-quality-use.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { commitBuffers, commitDbState, commitFileState, createCommitSourceHarness,
  makeCommitSource, type CommitSourceCase, type CommitSourceMode } from "./qa-correction-commit-fixture.js";

// C03: stored bytes must match the official patch, not merely submitted after-hashes.
// The helper may upload evidence, but may not issue DB use receipts, products or followup effects.
describe("C03 candidate bytes and quality evidence preparation", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "quality-storage"));
  }, 120000);
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  async function stage(quality = false, mode: CommitSourceMode = "content-only") {
    const s = await makeCommitSource(owned.db, owned.root, mode, false, quality);
    const p = await beginQaCorrection(owned.db, s.p);
    expect(p.status).toBe("prepared");
    if (p.status !== "prepared") throw Error("actual preparation required: " + p.status);
    const m = await measureQaCorrectionSources(owned.db, {
      preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
    const stored = await storeQaCorrection(owned.db, m);
    expect(await readFile(stored.outputs[0]!.mainPath)).toEqual(commitBuffers(mode, "new").get("report.html"));
    await commitFileState(s);
    return { s, stored };
  }
  async function state(s: CommitSourceCase, stored: StoredCorrection) {
    const names = new Set(s.bundles.flatMap(b => [b.directory, ...[...b.files.keys()].map(n => path.join(b.directory, n))]));
    for (const r of stored.revisions) {
      names.add(r.root);
      if (r.assetsRelativeRoot) names.add(path.join(r.root, r.assetsRelativeRoot));
      for (const f of r.files) names.add(path.join(r.root, f.relativePath));
    }
    const files = await Promise.all([...names].sort().map(async file => {
      const st = await lstat(file);
      return { file, mode: st.mode, dev: st.dev, ino: st.ino,
        bytes: st.isFile() ? await readFile(file) : null, link: st.isSymbolicLink() ? await readlink(file) : null };
    }));
    return { files, db: await commitDbState(s),
      assets: await owned.db.select().from(assets).where(eq(assets.companyId, s.p.companyId)).orderBy(assets.id),
      attachments: await owned.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, s.p.companyId)).orderBy(issueAttachments.id),
      actions: await owned.db.select().from(qualityActions).where(eq(qualityActions.companyId, s.p.companyId)).orderBy(qualityActions.id) };
  }
  async function overwrite(file: string, bytes: Buffer) {
    await chmod(file, 0o600); await writeFile(file, bytes); await chmod(file, 0o400);
  }
  it.each(["A", "A_asset", "A_ancillary", "B", "forged_patch", "file_symlink", "root_symlink", "asset_symlink", "manifest"] as const)(
    "rejects actual %s damage after a proven valid candidate, with no repair", async fault => {
      const { s, stored } = await stage(false, ["A_asset", "A_ancillary", "asset_symlink", "manifest"].includes(fault) ? "html" : "content-only");
      await validateQaCorrectionCommitCandidate(owned.db, stored);
      const c = structuredClone(stored), r = c.revisions[0]!, output = c.outputs[0]!;
      if (fault === "A") await overwrite(s.file, Buffer.from("changed A after store"));
      if (fault === "A_asset") await overwrite(path.join(s.directory, "assets/nested/pixel.svg"), Buffer.from("changed A asset"));
      if (fault === "A_ancillary") await overwrite(path.join(s.directory, "source-notes.txt"), Buffer.from("changed A notes"));
      if (fault === "B" || fault === "forged_patch") {
        const bytes = Buffer.from("forged B");
        await overwrite(output.mainPath, bytes);
        if (fault === "forged_patch") {
          const main = r.files.find(f => f.role === "main")!;
          main.sha256 = artifactFiles.digest(bytes); main.byteSize = bytes.length;
          expect(artifactFiles.digest(await readFile(output.mainPath))).toBe(main.sha256);
        }
      }
      if (fault === "file_symlink" || fault === "asset_symlink") {
        const file = fault === "file_symlink" ? output.mainPath : path.join(r.root, "assets/nested/pixel.svg");
        const directory = path.dirname(file);
        await chmod(directory, 0o700); await unlink(file); await symlink(s.file, file); await chmod(directory, 0o500);
        expect((await lstat(file)).isSymbolicLink()).toBe(true);
      }
      if (fault === "root_symlink") {
        const parent = path.dirname(r.root);
        await chmod(parent, 0o700); await rename(r.root, r.root + ".saved"); await symlink(r.root + ".saved", r.root);
      }
      if (fault === "manifest") await overwrite(path.join(r.root, "bundle-index.json"), Buffer.from("{}"));
      const before = await state(s, stored);
      await expect(validateQaCorrectionCommitCandidate(owned.db, c)).rejects.toThrow();
      expect(await state(s, stored)).toEqual(before);
    }, 20000);

  it.each(["items", "pass", "measurement", "preparation"] as const)(
    "rereads actual official records after storage: %s", async fault => {
      const { s, stored } = await stage(), token = await validateQaCorrectionCommitCandidate(owned.db, stored);
      if (fault === "pass") await appendQaVerdict(owned.db, s.f, "pass");
      if (fault === "items") {
        const id = s.p.authority.verdicts[0]!.eventId, [row] = await owned.db.select().from(workflowTransitionEvents)
          .where(eq(workflowTransitionEvents.id, id));
        const remediations = structuredClone(s.f.remediations); remediations.items[0]!.replace = "unapproved";
        await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, remediations } })
          .where(eq(workflowTransitionEvents.id, id));
      }
      if (fault === "measurement") {
        const body = structuredClone(stored.sourceMeasured); body.sources[0]!.files[0]!.byteSize++;
        await owned.db.update(workflowTransitionEvents).set({ payload: body })
          .where(eq(workflowTransitionEvents.id, stored.sourceMeasuredEventId));
      }
      if (fault === "preparation") {
        const body = qaCorrectionCommitDetails(token).preparation; body.dispatchAuthorityVersion++;
        await owned.db.update(workflowTransitionEvents).set({ payload: body })
          .where(eq(workflowTransitionEvents.id, stored.preparationEventId));
      }
      const before = await state(s, stored);
      await expect(validateQaCorrectionCommitCandidate(owned.db, stored)).rejects.toThrow();
      expect(await state(s, stored)).toEqual(before);
    }, 20000);
  it("requires the last whole A read even after a successful validation", async () => {
    const { s, stored } = await stage(), token = await validateQaCorrectionCommitCandidate(owned.db, stored);
    await rereadQaCorrectionCommitSources(token);
    await overwrite(s.file, Buffer.from("later A"));
    const before = await state(s, stored);
    await expect(rereadQaCorrectionCommitSources(token)).rejects.toThrow();
    expect(await state(s, stored)).toEqual(before);
  }, 20000);
  it("requires the exact final binding observation inside the real current transaction", async () => {
    const { s, stored } = await stage(), token = await validateQaCorrectionCommitCandidate(owned.db, stored);
    const d = qaCorrectionCommitDetails(token);
    await rereadQaCorrectionCommitSources(token);
    await owned.db.update(workflowStepOutputBindings).set({ resolvedAt: new Date(Date.now() + 1000) })
      .where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    const before = await state(s, stored);
    await expect(withCurrentQaCorrectionPreparation(owned.db, { preparationEventId: d.measured.preparationEventId,
      preparationHash: d.measured.preparationHash, preparation: d.preparation }, async tx => {
      await assertQaCorrectionCommitCurrent(tx, token); return { effect: "noop", value: null };
    })).rejects.toThrow();
    expect(await state(s, stored)).toEqual(before);
  }, 20000);

  it.each(["consume", "discard"] as const)("prepares actual exact quality evidence and its %s lifetime", async kind => {
    const { s, stored } = await stage(true, "html"), token = await validateQaCorrectionCommitCandidate(owned.db, stored);
    const d = qaCorrectionCommitDetails(token), a = d.preparation.authority;
    if (a.kind !== "quality_current_output") throw Error("quality preparation required");
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, a.actionId));
    const storage = getStorageService(), put = vi.spyOn(storage, "putFile"), get = vi.spyOn(storage, "getObject");
    const remove = vi.spyOn(storage, "deleteObject");
    onTestFinished(() => { put.mockRestore(); get.mockRestore(); remove.mockRestore(); });
    const before = await state(s, stored), appliedEventId = randomUUID();
    const prepared = await prepareQaCorrectionCommitQualityUse(token, appliedEventId);
    if (!prepared) throw Error("quality token required");
    const expected: useEvidence.QaCorrectionUseEvidenceBinding = {
      schemaVersion: "workflow.qa-correction.use-evidence.v1", kind: "use", issuedBy: "quality:current-output",
      originalRef: null, companyId: s.p.companyId, correctionId: s.p.correctionId, appliedEventId,
      ...d.measured, preparation: d.preparation, revisions: stored.revisions, actionId: a.actionId,
      reviewItemId: a.reviewItemId, source: a.source, scope: { kind: "output_correction", companyId: s.p.companyId,
        actionId: a.actionId, source: a.source, verifierRunId: a.verifierRunId, verifierEpoch: a.verifierEpoch },
      expiresAt: action!.retryEnvelope.deadlineAt,
      beforeHash: hashQaCorrectionPayload(stored.sourceMeasured.sources), revisionHash: hashQaCorrectionPayload(stored.revisions),
    };
    expect(prepared.binding).toEqual(expected);
    expect(put).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    const sent = put.mock.calls[0]![0], uploaded = await put.mock.results[0]!.value as PutFileResult;
    expect(sent.companyId).toBe(s.p.companyId); expect(sent.namespace).toBe("quality-evidence");
    expect(JSON.parse(sent.body.toString("utf8"))).toEqual(expected);
    expect(await readVerifiedEvidenceUpload(s.p.companyId, uploaded)).toEqual(sent.body);
    expect(Object.isFrozen(prepared.token)).toBe(true); expect(Reflect.ownKeys(prepared.token)).toEqual([]);
    expect(await state(s, stored)).toEqual(before); await rereadQaCorrectionCommitSources(token);
    if (kind === "discard") prepared.discard();
    else {
      const rollback = Error("owned token proof rollback");
      await expect(owned.db.transaction(async tx => {
        const linked = await useEvidence.linkPreparedQaCorrectionUseEvidence(tx, { token: prepared.token, expected });
        expect(linked.evidenceRefId).toBeTruthy(); expect(linked.ref.sha256).toBe(uploaded.sha256);
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await expect(owned.db.transaction(tx => useEvidence.linkPreparedQaCorrectionUseEvidence(tx,
      { token: prepared.token, expected }))).rejects.toMatchObject({ message: "quality_evidence_token_invalid" });
    expect(remove).not.toHaveBeenCalled(); expect(await state(s, stored)).toEqual(before);
  }, 20000);

  it.each(["upload", "readback", "body"] as const)("fails quality %s without a token or extra DB effects", async fault => {
    const { s, stored } = await stage(true), token = await validateQaCorrectionCommitCandidate(owned.db, stored);
    const storage = getStorageService(), putFile = storage.putFile.bind(storage), getObject = storage.getObject.bind(storage);
    let uploaded: PutFileResult | undefined;
    const put = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      if (fault === "upload") throw Error("owned upload failure");
      uploaded = await putFile(fault === "body" ? { ...input, body: Buffer.from("different complete body") } : input);
      return uploaded;
    });
    const get = vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (fault === "readback") throw Error("owned readback failure");
      return getObject(...args);
    });
    const prepare = vi.spyOn(useEvidence, "prepareQaCorrectionUseEvidence"), remove = vi.spyOn(storage, "deleteObject");
    onTestFinished(() => { put.mockRestore(); get.mockRestore(); prepare.mockRestore(); remove.mockRestore(); });
    const before = await state(s, stored);
    await expect(prepareQaCorrectionCommitQualityUse(token, randomUUID())).rejects.toThrow();
    if (fault === "upload") expect(prepare).not.toHaveBeenCalled();
    else {
      expect(prepare).toHaveBeenCalledTimes(1);
      await expect(prepare.mock.results[0]!.value).rejects.toThrow();
      expect(uploaded).toBeDefined();
    }
    expect(remove).not.toHaveBeenCalled(); expect(await state(s, stored)).toEqual(before);
    get.mockRestore();
    if (uploaded) {
      // Orphan bytes remain readable; no cleanup disguises failed evidence preparation.
      const actual = await readVerifiedEvidenceUpload(s.p.companyId, uploaded);
      expect(actual.length).toBe(uploaded.byteSize);
    }
  }, 20000);

  it.each([false, true])("keeps every IO outside TX and noop effects rolled back, missing usage=%s", async missingUsage => {
    const { s, stored } = await stage(missingUsage);
    if (missingUsage) await owned.db.delete(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, s.p.companyId));
    const before = await state(s, stored), transaction = owned.db.transaction.bind(owned.db);
    const read = artifactFiles.readArtifactBytes, capture = artifactFiles.captureArtifactRoot; let active = 0, reads = 0;
    const tx = vi.spyOn(owned.db, "transaction").mockImplementation((callback, config) => transaction(async t => {
      active++; try { return await callback(t); } finally { active--; }
    }, config));
    const r = vi.spyOn(artifactFiles, "readArtifactBytes").mockImplementation(async (...args) => {
      expect(active).toBe(0); reads++; return read(...args);
    });
    const c = vi.spyOn(artifactFiles, "captureArtifactRoot").mockImplementation(async (...args) => {
      expect(active).toBe(0); return capture(...args);
    });
    const storage = getStorageService(), putFile = storage.putFile.bind(storage), getObject = storage.getObject.bind(storage);
    const put = vi.spyOn(storage, "putFile").mockImplementation(async input => { expect(active).toBe(0); return putFile(input); });
    const get = vi.spyOn(storage, "getObject").mockImplementation(async (...args) => { expect(active).toBe(0); return getObject(...args); });
    onTestFinished(() => { tx.mockRestore(); r.mockRestore(); c.mockRestore(); put.mockRestore(); get.mockRestore(); });
    const token = await validateQaCorrectionCommitCandidate(owned.db, stored);
    const prepared = await prepareQaCorrectionCommitQualityUse(token, randomUUID());
    if (missingUsage) { expect(prepared).not.toBeNull(); prepared!.discard(); }
    else { expect(prepared).toBeNull(); expect(put).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); }
    await rereadQaCorrectionCommitSources(token);
    expect(reads).toBeGreaterThanOrEqual(3); expect(await state(s, stored)).toEqual(before);
  }, 20000);
});
