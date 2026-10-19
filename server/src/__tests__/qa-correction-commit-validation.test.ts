import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, issueWorkProducts, workflowTransitionEvents } from "@paperclipai/db";
import { captureArtifactRoot, digest } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory } from "../services/workflow/artifact-writer.js";
import { beginQaCorrection, withCurrentQaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection, type StoredCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { assertQaCorrectionCommitCurrent, qaCorrectionCommitDetails, rereadQaCorrectionCommitSources,
  validateQaCorrectionCommitCandidate } from "../services/workflow/control-flow/qa-correction-commit-validation.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { commitBuffers, commitDbState, commitFacts, commitFileState, createCommitSourceHarness,
  hideCommitDeclaration, makeCommitPrior, makeCommitSource, type CommitSourceCase } from "./qa-correction-commit-fixture.js";

// C03 adopted §§6–8: only the ordered official replacements may change A; everything else is preserved.
// Prior fixtures prove historical INPUT compatibility, not commit issuance or actual tool-QA delivery.
describe("C03 whole stored candidate validation", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => { owned = await createCommitSourceHarness(); }, 120000);
  afterAll(async () => { await owned?.close(); }, 120000);
  async function stage(s: CommitSourceCase) {
    const p = await beginQaCorrection(owned.db, s.p);
    expect(p.status).toBe("prepared");
    if (p.status !== "prepared") throw Error("actual preparation required: " + p.status);
    const m = await measureQaCorrectionSources(owned.db, {
      preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
    expect(m.sourceMeasured.sources.find(source => source.productId === s.productId)?.files).toEqual(commitFacts(s.files));
    return storeQaCorrection(owned.db, m);
  }
  async function files(s: CommitSourceCase, stored: StoredCorrection) {
    const names = new Set<string>();
    for (const bundle of s.bundles) {
      names.add(bundle.directory);
      for (const name of bundle.files.keys()) names.add(path.join(bundle.directory, name));
    }
    for (const r of stored.revisions) {
      names.add(r.root);
      if (r.assetsRelativeRoot) names.add(path.join(r.root, r.assetsRelativeRoot));
      for (const f of r.files) names.add(path.join(r.root, f.relativePath));
    }
    return Promise.all([...names].sort().map(async file => {
      const st = await lstat(file);
      return { file, dev: st.dev, ino: st.ino, mode: st.mode, bytes: st.isFile() ? await readFile(file) : null,
        link: st.isSymbolicLink() ? await readlink(file) : null };
    }));
  }
  async function unchanged(s: CommitSourceCase, stored: StoredCorrection, run: () => Promise<unknown>) {
    const before = { db: await commitDbState(s), files: await files(s, stored) };
    await run();
    expect({ db: await commitDbState(s), files: await files(s, stored) }).toEqual(before);
  }
  for (const prior of [false, true]) it.each(["html", "content", "empty", "content-only"] as const)(
    "accepts exact %s bytes, prior=" + prior, async mode => {
      let s = await makeCommitSource(owned.db, owned.root, mode);
      if (prior) s = await makeCommitPrior(s);
      const original = await commitFileState(s), stored = await stage(s);
      const expected = commitBuffers(mode, prior ? "final" : "new"), r = stored.revisions[0]!;
      expect([...r.files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
        .toEqual(commitFacts(expected).map(f => ({ ...f, beforeSha256: digest(s.files.get(f.relativePath)!) })));
      for (const [relative, bytes] of expected) expect(await readFile(path.join(r.root, relative))).toEqual(bytes);
      expect(r.assetsRelativeRoot).toBe(mode === "content-only" ? null : "assets");
      expect(r.bundleManifestRelativePath).toBe(mode === "html" ? "bundle-index.json" : null);
      expect(r.files.filter(f => f.role === "asset")).toHaveLength(mode === "content" ? 9 : mode === "html" ? 1 : 0);
      if (mode === "html") {
        const manifest = JSON.parse((await readFile(path.join(r.root, "bundle-index.json"))).toString());
        expect(manifest.htmlSha256).toBe(digest(await readFile(stored.outputs[0]!.mainPath)));
        expect(await readFile(path.join(r.root, "source-notes.txt"))).toEqual(s.files.get("source-notes.txt"));
        expect(await readFile(path.join(r.root, "assets/nested/pixel.svg"))).toEqual(s.files.get("assets/nested/pixel.svg"));
      }
      await unchanged(s, stored, async () => {
        const token = await validateQaCorrectionCommitCandidate(owned.db, stored), d = qaCorrectionCommitDetails(token);
        expect(d.stored).toEqual(stored);
        expect(d.beforeHash).toBe(hashQaCorrectionPayload(stored.sourceMeasured.sources));
        expect(d.revisionHash).toBe(hashQaCorrectionPayload(stored.revisions));
        await rereadQaCorrectionCommitSources(token);
        const current = await withCurrentQaCorrectionPreparation(owned.db, {
          preparationEventId: d.measured.preparationEventId, preparationHash: d.measured.preparationHash,
          preparation: d.preparation }, async tx => {
          await assertQaCorrectionCommitCurrent(tx, token);
          return { effect: "noop", value: null };
        });
        expect(current.status).toBe("current");
        d.stored.revisions[0]!.root = "/detached";
        expect(qaCorrectionCommitDetails(token).stored).toEqual(stored);
      });
      expect(await commitFileState(s)).toEqual(original);
    }, 20000);

  it.each(["original", "mission-prior", "bare-prior"] as const)(
    "preserves undeclared registered-legacy storage selection: %s", async kind => {
      let s = await makeCommitSource(owned.db, owned.root, "content-only", true);
      if (kind !== "original") s = await makeCommitPrior(s);
      if (kind === "bare-prior") {
        const h = s.history!, revision = h.applied.revisions[0]!;
        const relative = path.join("qa-corrections", h.preparation.correctionId, randomUUID(), revision.sourceProductId);
        const root = await createArtifactDirectory(await captureArtifactRoot(owned.root), relative,
          [...s.files].map(([relative, bytes]) => ({ relative, bytes })), ["."]);
        revision.root = root.path;
        await owned.db.update(workflowTransitionEvents).set({ payload: h.applied }).where(eq(workflowTransitionEvents.id, h.appliedId));
        s.directory = root.path; s.file = path.join(root.path, "report.html"); s.bundles.push({ directory: root.path, files: s.files });
        await owned.db.update(issueWorkProducts).set({ externalId: s.file, metadata: {
          path: s.file, qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1",
            appliedEventId: h.appliedId, revisionId: revision.revisionId } } }).where(eq(issueWorkProducts.id, s.productId));
        s.f.remediations.items[0]!.file = s.file;
        const v = s.p.authority.verdicts[0]!, [row] = await owned.db.select().from(workflowTransitionEvents)
          .where(eq(workflowTransitionEvents.id, v.eventId));
        await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, remediations: s.f.remediations } })
          .where(eq(workflowTransitionEvents.id, v.eventId));
        v.remediationsHash = hashQaCorrectionPayload(s.f.remediations.items);
      }
      await hideCommitDeclaration(s);
      await owned.db.update(companies).set({ workProductRoot: null }).where(eq(companies.id, s.p.companyId));
      const stored = await stage(s), expectedBase = kind === "original" ? s.directory : owned.root;
      const prefix = kind === "mission-prior" ? path.join("missions", s.p.missionId) : "";
      expect(stored.revisions[0]!.root.startsWith(path.join(expectedBase, prefix, "qa-corrections", s.p.correctionId) + path.sep)).toBe(true);
      await unchanged(s, stored, () => validateQaCorrectionCommitCandidate(owned.db, stored));
    }, 20000);

  const mutations: Record<string, (c: StoredCorrection) => void> = {
    status: c => { Object.assign(c, { status: "committed" }); },
    preparation_id: c => { c.preparationEventId = randomUUID(); },
    preparation_hash: c => { c.preparationHash = "ff".repeat(32); },
    measurement_id: c => { c.sourceMeasuredEventId = randomUUID(); },
    measurement_hash: c => { c.sourceMeasuredHash = "ff".repeat(32); },
    measurement_body: c => { c.sourceMeasured.measuredAt = new Date(0).toISOString(); },
    measurement_product: c => { c.sourceMeasured.sources[0]!.productId = randomUUID();
      c.sourceMeasuredHash = hashQaCorrectionPayload(c.sourceMeasured); },
    source_product: c => { c.revisions[0]!.sourceProductId = randomUUID(); },
    output_product: c => { c.outputs[0]!.sourceProductId = randomUUID(); },
    output_missing: c => { c.outputs = []; },
    output_duplicate: c => { c.outputs.push(structuredClone(c.outputs[0]!)); },
    revision_duplicate: c => { c.revisions.push(structuredClone(c.revisions[0]!)); },
    revision_missing: c => { c.revisions = []; },
    revision_id: c => { c.revisions[0]!.revisionId = "not-a-uuid"; },
    product_identity: c => { c.revisions[0]!.workProductId = c.revisions[0]!.sourceProductId; },
    main: c => { c.revisions[0]!.mainRelativePath = "source-notes.txt"; },
    manifest_null: c => { c.revisions[0]!.bundleManifestRelativePath = null; },
    manifest_missing: c => { delete (c.revisions[0]! as Partial<StoredCorrection["revisions"][number]>).bundleManifestRelativePath; },
    assets_null: c => { c.revisions[0]!.assetsRelativeRoot = null; },
    assets_missing: c => { delete (c.revisions[0]! as Partial<StoredCorrection["revisions"][number]>).assetsRelativeRoot; },
    assets_type: c => { Object.assign(c.revisions[0]!, { assetsRelativeRoot: 7 }); },
    file_before: c => { c.revisions[0]!.files[0]!.beforeSha256 = "ff".repeat(32); },
    file_after: c => { c.revisions[0]!.files[0]!.sha256 = "ff".repeat(32); },
    file_size: c => { c.revisions[0]!.files[0]!.byteSize++; },
    file_role: c => { c.revisions[0]!.files.find(f => f.role === "asset")!.role = "ancillary"; },
    file_path: c => { c.revisions[0]!.files[0]!.relativePath = "other.html"; },
    file_duplicate: c => { c.revisions[0]!.files.push({ ...c.revisions[0]!.files[0]! }); },
    file_missing: c => { c.revisions[0]!.files.pop(); },
    root: c => { c.revisions[0]!.root += "/wrong"; },
    root_device: c => { c.outputs[0]!.artifactRoot.dev++; },
    root_inode: c => { c.outputs[0]!.artifactRoot.ino++; },
    output_root: c => { c.outputs[0]!.artifactRoot.path += "/wrong"; },
    output_main: c => { c.outputs[0]!.mainPath += ".wrong"; },
    output_assets: c => { c.outputs[0]!.assetsRoot = null; },
    extra: c => { Object.assign(c, { untrusted: true }); },
  };
  it.each(Object.keys(mutations))("rejects a single %s mutation after proving the exact valid candidate", async field => {
    const s = await makeCommitSource(owned.db, owned.root), stored = await stage(s);
    await validateQaCorrectionCommitCandidate(owned.db, stored);
    const changed = structuredClone(stored); mutations[field]!(changed);
    await unchanged(s, stored, async () => { await expect(validateQaCorrectionCommitCandidate(owned.db, changed)).rejects.toThrow(); });
  }, 20000);

  it.each(["candidate", "revision", "product", "output"] as const)(
    "rejects cross-candidate mixing and duplicate identities: %s", async fault => {
      const s = await makeCommitSource(owned.db, owned.root, "content-only", true);
      await hideCommitDeclaration(s);
      const [second] = await owned.db.insert(issueWorkProducts).values({ companyId: s.p.companyId,
        issueId: s.p.producer.issueId, type: "artifact", provider: "local_file", title: "second",
        status: "active", url: s.file, metadata: { path: s.file } }).returning();
      s.p.sources.push({ productId: second!.id, provenance: { kind: "registered_legacy" } });
      const a = await stage(s), ref = { preparationEventId: a.preparationEventId, preparationHash: a.preparationHash,
        sourceMeasuredEventId: a.sourceMeasuredEventId, sourceMeasuredHash: a.sourceMeasuredHash, sourceMeasured: a.sourceMeasured };
      const b = await storeQaCorrection(owned.db, ref);
      expect(a.revisions).toHaveLength(2);
      await validateQaCorrectionCommitCandidate(owned.db, a); await validateQaCorrectionCommitCandidate(owned.db, b);
      const c = structuredClone(a);
      if (fault === "candidate") { c.revisions[1] = b.revisions[1]!; c.outputs[1] = b.outputs[1]!; }
      if (fault === "revision") c.revisions[1]!.revisionId = c.revisions[0]!.revisionId;
      if (fault === "product") c.revisions[1]!.workProductId = c.revisions[0]!.workProductId;
      if (fault === "output") c.outputs[1] = structuredClone(c.outputs[0]!);
      const both = { ...a, revisions: [...a.revisions, ...b.revisions], outputs: [...a.outputs, ...b.outputs] };
      await unchanged(s, both, async () => { await expect(validateQaCorrectionCommitCandidate(owned.db, c)).rejects.toThrow(); });
    }, 20000);

  it.each(["company", "mission", "correction", "source"] as const)(
    "rejects complete real bytes copied into another managed %s placement", async fault => {
      const s = await makeCommitSource(owned.db, owned.root, "content-only"), stored = await stage(s);
      await validateQaCorrectionCommitCandidate(owned.db, stored);
      const c = structuredClone(stored), r = c.revisions[0]!, candidateId = path.basename(path.dirname(r.root));
      const relative = path.join(fault === "company" ? "foreign-company" : "", "missions",
        fault === "mission" ? randomUUID() : s.p.missionId, "qa-corrections",
        fault === "correction" ? randomUUID() : s.p.correctionId, candidateId,
        fault === "source" ? randomUUID() : s.productId);
      const root = await createArtifactDirectory(await captureArtifactRoot(owned.root), relative,
        await Promise.all(r.files.map(async f => ({ relative: f.relativePath, bytes: await readFile(path.join(r.root, f.relativePath)) }))), ["."]);
      r.root = root.path; c.outputs[0] = { sourceProductId: s.productId, artifactRoot: root,
        mainPath: path.join(root.path, r.mainRelativePath), assetsRoot: null };
      expect(await readFile(c.outputs[0]!.mainPath)).toEqual(commitBuffers("content-only", "new").get("report.html"));
      await unchanged(s, { ...stored, revisions: [...stored.revisions, r] }, async () => {
        await expect(validateQaCorrectionCommitCandidate(owned.db, c)).rejects.toMatchObject({ reason: "source" });
      });
    }, 20000);

  it("reconstructs sequential official items in their recorded order", async () => {
    const s = await makeCommitSource(owned.db, owned.root, "content-only");
    s.f.remediations.items = [
      { op: "string_replace", file: s.file, find: "old", replace: "middle" },
      { op: "string_replace", file: s.file, find: "middle", replace: "new" },
    ];
    const v = s.p.authority.verdicts[0]!, [row] = await owned.db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, v.eventId));
    await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, remediations: s.f.remediations } })
      .where(eq(workflowTransitionEvents.id, v.eventId));
    v.remediationsHash = hashQaCorrectionPayload(s.f.remediations.items);
    const stored = await stage(s);
    expect(await readFile(stored.outputs[0]!.mainPath)).toEqual(commitBuffers("content-only", "new").get("report.html"));
    await unchanged(s, stored, () => validateQaCorrectionCommitCandidate(owned.db, stored));
  }, 20000);
});
