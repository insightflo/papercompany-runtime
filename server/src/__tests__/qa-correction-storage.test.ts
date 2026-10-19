import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issueWorkProducts, qualityActionGroups,
  qualityEvidenceRefs, qualityPolicyUsage, workflowDefinitions, workflowRuns, workflowStepOutputBindings,
  workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources, type MeasuredRef } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { patchQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-patch.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { createArtifactDirectory } from "../services/workflow/artifact-writer.js";
import { captureArtifactRoot, digest } from "../services/workflow/artifact-files.js";
import * as artifactFiles from "../services/workflow/artifact-files.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { appendQaVerdict, createQaCorrectionTestDb, issueQaCorrectionFixture, seedQaCorrection,
  type CorrectionFixture } from "./helpers/qa-correction-fixture.js";

describe("C03/C12 whole immutable correction storage", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, root: string;
  beforeAll(async () => {
    owned = await createQaCorrectionTestDb(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-store-")));
  }, 120000);
  afterAll(async () => {
    await owned?.close();
    if (root) { execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); }
  }, 120000);
  async function state(f: CorrectionFixture) {
    const id = f.preparation.companyId;
    return {
      events: await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, id)).orderBy(asc(workflowTransitionEvents.id)),
      usage: await owned.db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, id)),
      groups: await owned.db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, id)),
      products: await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, id)).orderBy(asc(issueWorkProducts.id)),
      bindings: await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.companyId, id)),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, id)),
      wakes: await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id)).orderBy(asc(agentWakeupRequests.id)),
    };
  }
  async function official(f: CorrectionFixture) {
    const v = f.preparation.authority.verdicts[0]!;
    const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, v.eventId));
    await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, remediations: f.remediations } })
      .where(eq(workflowTransitionEvents.id, v.eventId));
    v.remediationsHash = hashQaCorrectionPayload(f.remediations.items);
  }
  async function seed(mode: "registered_legacy" | "identity" | "sealed" = "registered_legacy", declared = false, quality = false) {
    const f = await seedQaCorrection(owned.db, mode, quality), p = f.preparation;
    const dir = declared ? path.join(root, "missions", p.missionId, "draft") : path.join(root, "inputs", p.companyId);
    const file = path.join(dir, "report.html"); await mkdir(dir, { recursive: true }); await writeFile(file, "old");
    await owned.db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, p.companyId));
    const [product] = await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, f.productId));
    await owned.db.update(issueWorkProducts).set({ url: file, metadata: { ...product!.metadata, path: file } })
      .where(eq(issueWorkProducts.id, f.productId));
    f.remediations.items[0]!.file = file; await official(f);
    return { f, dir, file };
  }
  async function measure(f: CorrectionFixture) {
    const p = await beginQaCorrection(owned.db, f.preparation);
    if (p.status !== "prepared") throw Error("actual begin required: " + p.status);
    return measureQaCorrectionSources(owned.db, { preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
  }
  async function saved(f: CorrectionFixture, m: MeasuredRef, dir: string, main: Buffer) {
    const before = await state(f), facts = m.sourceMeasured.sources[0]!.files;
    const originals = await Promise.all(facts.map(async x => ({
      ...x, bytes: await readFile(path.join(dir, x.relativePath)), mode: (await stat(path.join(dir, x.relativePath))).mode,
    })));
    const result = await storeQaCorrection(owned.db, m), revision = result.revisions[0]!, output = result.outputs[0]!;
    expect(result.status).toBe("stored_uncommitted"); expect(result.sourceMeasured).toEqual(m.sourceMeasured);
    expect(result.revisions).toHaveLength(1); expect(result.outputs).toHaveLength(1);
    expect(output.mainPath).toBe(path.join(revision.root, revision.mainRelativePath));
    for (const original of originals) {
      const bytes = await readFile(path.join(revision.root, original.relativePath));
      const tuple = revision.files.find(x => x.relativePath === original.relativePath)!;
      expect(tuple).toEqual({ role: original.role, relativePath: original.relativePath,
        beforeSha256: original.sha256, sha256: digest(bytes), byteSize: bytes.length });
      if (original.role === "main") expect(bytes).toEqual(main);
      else if (original.relativePath === revision.bundleManifestRelativePath) {
        expect(JSON.parse(bytes.toString())).toEqual({ ...JSON.parse(original.bytes.toString()), htmlSha256: digest(main) });
      } else expect(bytes).toEqual(original.bytes);
      expect(await readFile(path.join(dir, original.relativePath))).toEqual(original.bytes);
      expect((await stat(path.join(dir, original.relativePath))).mode).toBe(original.mode);
      expect((await stat(path.join(revision.root, original.relativePath))).mode & 0o222).toBe(0);
      expect((await stat(path.dirname(path.join(revision.root, original.relativePath)))).mode & 0o222).toBe(0);
    }
    expect((await stat(revision.root)).mode & 0o222).toBe(0);
    expect(await state(f)).toEqual(before);
    expect(before.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(before.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
    return result;
  }
  type Kind = "content" | "empty" | "only" | "html" | "html-empty";
  async function declared(kind: Kind) {
    const s = await seed("identity", true), { f, dir, file } = s, p = f.preparation, html = kind.startsWith("html");
    const names = kind === "content" ? Array.from({ length: 9 }, (_, i) => "nested/img-" + i + ".png") : kind === "html" ? ["nested/x.png"] : [];
    await mkdir(path.join(dir, "assets", "nested"), { recursive: true });
    for (const name of names) await writeFile(path.join(dir, "assets", name), name);
    const bytes = Buffer.from(html ? "<p>old</p>" : JSON.stringify({ schemaVersion: "ContentV1", title: "old",
      summary: "Draft", tags: ["fixture"], blocks: names.map(assetFile => ({ type: "image", assetFile })) }));
    await writeFile(file, bytes); const manifest = "bundle-index.json";
    if (html) {
      await writeFile(path.join(dir, "source-notes.txt"), "notes");
      await writeFile(path.join(dir, manifest), JSON.stringify({ schemaVersion: "bundle.v1", htmlSha256: digest(bytes),
        assets: names.map(fileName => ({ fileName, sha256: digest(fileName), byteSize: Buffer.byteLength(fileName) })),
        ancillary: [{ role: "research", fileName: "source-notes.txt", sha256: digest("notes"), byteSize: 5 }] }));
    }
    await owned.db.update(issueWorkProducts).set({ type: "artifact" }).where(eq(issueWorkProducts.id, f.productId));
    const contract = { role: "qa" as const, resultFileName: "qa.json", resultSchemaVersion: "workflow.qa-result.v1",
      resultAdapter: "generic" as const, deploymentFiles: ["qa.mjs"], inputEnvelopeVersion: "workflow.artifact-input.v1",
      inputParams: html ? { html: "html", manifest: "manifest", out: "out" }
        : kind === "only" ? { content: "content" } : { content: "content", assetsDir: "assets", out: "out" },
      ...(html ? { bundleManifest: { fileName: manifest, schemaVersion: "bundle.v1", ancillaryRoles: ["research"] } }
        : { assetDiscovery: names.length ? ["/blocks/*/assetFile"] : [] }) };
    const [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const steps = (definition!.stepsJson as { id: string; [key: string]: unknown }[]).map(step => step.id !== f.qa.stepId ? step : {
      ...step, toolArtifactContract: { role: "qa", schemaVersion: contract.resultSchemaVersion, inputStepId: "produce" },
      workProductSelectors: { produce: { type: "artifact", title: "report" } } });
    await owned.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition!.id));
    const requestId = randomUUID(), artifactExecution = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract },
      step: steps.find(step => step.id === f.qa.stepId), executionGeneration: f.qa.executionGeneration, requestId });
    await owned.db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId, metadata: { artifactExecution } }).where(eq(workflowStepRuns.id, f.qa.id));
    const request = await prepareQaArtifactRequest({ db: owned.db, companyId: p.companyId, workflowRunId: p.workflowRunId,
      stepRunId: f.qa.id, stepId: f.qa.stepId, requestId, parameters: html ? { html: file, manifest: path.join(dir, manifest) }
        : { content: file, ...(kind === "only" ? {} : { assets: path.join(dir, "assets") }) } });
    expect(request).not.toBeNull();
    await owned.db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.qa.id));
    return { ...s, bytes, names, html, manifest, definition, steps };
  }
  it.each(["registered_legacy", "identity", "sealed"] as const)("stores %s without changing A or DB; absent mission directory", async mode => {
    const { f, dir } = await seed(mode, false, true), m = await measure(f);
    await expect(stat(path.join(root, "missions", f.preparation.missionId))).rejects.toThrow();
    const result = await saved(f, m, dir, Buffer.from("new")), r = result.revisions[0]!;
    expect(r.bundleManifestRelativePath).toBeNull(); expect(r.assetsRelativeRoot).toBeNull();
    expect(r.root.startsWith(path.join(root, "missions", f.preparation.missionId, "qa-corrections", f.preparation.correctionId) + "/")).toBe(true);
  });
  it.each(["content", "empty", "only", "html", "html-empty"] as const)("preserves declared %s layout and all assets", async kind => {
    const s = await declared(kind), m = await measure(s.f), result = await saved(s.f, m, s.dir, Buffer.from(s.bytes.toString().replace("old", "new")));
    const r = result.revisions[0]!, output = result.outputs[0]!;
    expect(r.bundleManifestRelativePath).toBe(s.html ? s.manifest : null);
    expect(r.assetsRelativeRoot).toBe(kind === "only" ? null : "assets");
    expect(r.files.filter(f => f.role === "asset")).toHaveLength(s.names.length);
    expect(output.assetsRoot).toBe(kind === "only" ? null : path.join(r.root, "assets"));
    if (output.assetsRoot) expect((await stat(output.assetsRoot)).mode & 0o222).toBe(0);
  }, 20000);
  it("applies official items in order to the same measured file", async () => {
    const { f, dir, file } = await seed();
    f.remediations.items = [{ op: "string_replace", file, find: "old", replace: "middle" },
      { op: "string_replace", file, find: "middle", replace: "final" }]; await official(f);
    await saved(f, await measure(f), dir, Buffer.from("final"));
  });
  it.each(["missing", "multiple", "overlap", "oversize", "outside"] as const)("rejects %s without effects", async kind => {
    const { f, file } = await seed();
    if (kind === "missing") f.remediations.items[0]!.find = "absent";
    if (kind === "multiple") await writeFile(file, "old old");
    if (kind === "overlap") { await writeFile(file, "aaa"); f.remediations.items[0]!.find = "aa"; }
    if (kind === "oversize") await writeFile(file, "old" + "x".repeat(2 * 1024 * 1024));
    if (kind === "outside") f.remediations.items[0]!.file = path.join(path.dirname(file), "unmeasured.txt");
    await official(f); const m = await measure(f), before = await state(f), bytes = await readFile(file), mode = (await stat(file)).mode;
    await expect(storeQaCorrection(owned.db, m)).rejects.toMatchObject({ reason: "source" });
    expect(await state(f)).toEqual(before); expect(await readFile(file)).toEqual(bytes); expect((await stat(file)).mode).toBe(mode);
  });
  it("deduplicates shared physical sources while preserving verdict order and original buffers", () => {
    const bytes = Buffer.from("old"), file = { role: "main" as const, relativePath: "a.txt", sourcePath: "/held/a.txt",
      bytes, sha256: digest(bytes), byteSize: 3 };
    const sources = ["one", "two"].map(productId => ({ productId, root: { path: "/held", dev: 1, ino: 1 },
      mainRelativePath: "a.txt", assetsRoot: null, files: [{ ...file }] }));
    const result = patchQaCorrectionSources(sources, ["old", "middle"].map((find, i) => ({
      items: [{ op: "string_replace" as const, file: "/held/a.txt", find, replace: i ? "final" : "middle" }],
    })), sources.map(s => ({ productId: s.productId, bundleManifestRelativePath: null, assetsRelativeRoot: null })));
    expect(result.map(s => s.files[0]!.bytes.toString())).toEqual(["final", "final"]); expect(bytes.toString()).toBe("old");
    expect(result.map(s => s.files[0]!.beforeSha256)).toEqual([digest("old"), digest("old")]);
  });
  it.each(["type", "layer", "key", "company", "mission", "run", "step", "issue", "generation", "time",
    "before-preparation", "link", "products", "ref-hash", "ref-body", "ref-preparation"] as const)("rejects forged measured %s", async kind => {
    const { f } = await seed(), m = await measure(f);
    const patch: Partial<typeof workflowTransitionEvents.$inferInsert> = {};
    const fields = { type: "eventType", layer: "layer", key: "idempotencyKey", company: "companyId",
      mission: "missionId", run: "workflowRunId", step: "workflowStepRunId", issue: "issueId" } as const;
    if (kind in fields) Object.assign(patch, { [fields[kind as keyof typeof fields]]: ["type", "layer", "key"].includes(kind) ? "forged" : randomUUID() });
    if (kind === "generation") patch.executionGeneration = 9;
    if (kind === "time") patch.createdAt = new Date(0);
    if (["before-preparation", "link", "products"].includes(kind)) {
      if (kind === "before-preparation") m.sourceMeasured.measuredAt = new Date(0).toISOString();
      if (kind === "link") m.sourceMeasured.preparationHash = "ff".repeat(32);
      if (kind === "products") m.sourceMeasured.sources[0]!.productId = randomUUID();
      patch.payload = m.sourceMeasured; patch.createdAt = new Date(m.sourceMeasured.measuredAt);
      m.sourceMeasuredHash = hashQaCorrectionPayload(m.sourceMeasured);
    }
    if (kind === "ref-hash") m.sourceMeasuredHash = "ff".repeat(32);
    if (kind === "ref-body") m.sourceMeasured.sources[0]!.files[0]!.byteSize++;
    if (kind === "ref-preparation") m.preparationHash = "ff".repeat(32);
    if (Object.keys(patch).length) await owned.db.update(workflowTransitionEvents).set(patch).where(eq(workflowTransitionEvents.id, m.sourceMeasuredEventId));
    const before = await state(f), spy = vi.spyOn(artifactFiles, "readArtifactBytes");
    onTestFinished(() => spy.mockRestore());
    await expect(storeQaCorrection(owned.db, m)).rejects.toMatchObject({ reason: "record" });
    expect(spy).not.toHaveBeenCalled(); expect(await state(f)).toEqual(before);
  });
  async function history(kind: Kind, layout: "mission" | "local" | "arbitrary") {
    const s = await declared(kind), { f } = s, p = f.preparation;
    const names = ["report.html", ...s.names.map(n => "assets/" + n), ...(s.html ? ["source-notes.txt", s.manifest] : [])];
    const before = await Promise.all(names.map(async relativePath => {
      const bytes = await readFile(path.join(s.dir, relativePath));
      return { relativePath, role: relativePath === "report.html" ? "main" as const : relativePath.startsWith("assets/") ? "asset" as const : "ancillary" as const,
        bytes, sha256: digest(bytes), byteSize: bytes.length };
    }));
    const main = Buffer.from(s.bytes.toString().replace("old", "new"));
    const files = before.map(file => ({ ...file, bytes: file.role === "main" ? main : file.relativePath === s.manifest
      ? Buffer.from(JSON.stringify({ ...JSON.parse(file.bytes.toString()), htmlSha256: digest(main) })) : file.bytes }));
    // Historical INPUT ONLY: this fixture is not a storage commit or current registration proof.
    p.preparedAt = new Date().toISOString(); const issued = await issueQaCorrectionFixture(owned.db, f);
    const prefix = layout === "mission" ? path.join("missions", p.missionId) : "";
    const relative = layout === "arbitrary" ? "unmanaged/" + randomUUID()
      : path.join(prefix, "qa-corrections", p.correctionId, randomUUID(), f.productId);
    const b = await createArtifactDirectory(await captureArtifactRoot(root), relative,
      files.map(x => ({ relative: x.relativePath, bytes: x.bytes })), [".", ...(kind === "only" ? [] : ["assets", "assets/nested"])]);
    issued.measured.sources[0]!.files = before.map(({ role, relativePath, sha256, byteSize }) => ({ role, relativePath, sha256, byteSize }));
    const r = issued.applied.revisions[0]!; r.root = b.path; r.bundleManifestRelativePath = s.html ? s.manifest : null;
    r.assetsRelativeRoot = kind === "only" ? null : "assets";
    r.files = files.map(x => ({ role: x.role, relativePath: x.relativePath, beforeSha256: x.sha256, sha256: digest(x.bytes), byteSize: x.bytes.length }));
    issued.applied.sourceMeasuredHash = hashQaCorrectionPayload(issued.measured);
    await owned.db.update(workflowTransitionEvents).set({ payload: issued.measured }).where(eq(workflowTransitionEvents.id, issued.measuredId));
    await owned.db.update(workflowTransitionEvents).set({ payload: issued.applied }).where(eq(workflowTransitionEvents.id, issued.appliedId));
    const [product] = await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, issued.workProductId));
    await owned.db.update(issueWorkProducts).set({ metadata: { ...product!.metadata, path: path.join(b.path, "report.html") } }).where(eq(issueWorkProducts.id, issued.workProductId));
    await owned.db.update(workflowDefinitions).set({ stepsJson: s.steps.map(step => {
      const copy: Record<string, unknown> = { ...step }; delete copy.toolArtifactContract; return copy;
    }) }).where(eq(workflowDefinitions.id, s.definition!.id));
    await owned.db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, f.qa.id));
    await owned.db.update(companies).set({ workProductRoot: null }).where(eq(companies.id, p.companyId));
    f.remediations.items = [{ op: "string_replace", file: path.join(b.path, "report.html"), find: "new", replace: "final" }];
    const v = await appendQaVerdict(owned.db, f, "request_changes"), now = new Date();
    await owned.db.update(heartbeatRuns).set({ createdAt: now }).where(eq(heartbeatRuns.id, v.heartbeatRunId));
    await owned.db.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, v.eventId));
    p.correctionId = randomUUID(); p.authority.verdicts = [v]; p.sources = [{ productId: issued.workProductId,
      provenance: { kind: "prior_correction", appliedEventId: issued.appliedId } }]; p.bindings[0]!.expectedProductId = issued.workProductId;
    return { ...s, issued, revision: r, files, prefix, measured: await measure(f) };
  }
  it.each((["content", "empty", "only", "html", "html-empty"] as const).flatMap(kind =>
    (["mission", "local"] as const).map(layout => ({ kind, layout }))))("uses historical format and original $layout base for $kind B→C", async ({ kind, layout }) => {
    const h = await history(kind, layout), before = await state(h.f), bMode = (await stat(h.revision.root)).mode;
    const result = await storeQaCorrection(owned.db, h.measured), c = result.revisions[0]!;
    expect(c.root.startsWith(path.join(root, h.prefix, "qa-corrections", h.f.preparation.correctionId) + "/")).toBe(true);
    expect(c.bundleManifestRelativePath).toBe(h.revision.bundleManifestRelativePath); expect(c.assetsRelativeRoot).toBe(h.revision.assetsRelativeRoot);
    for (const file of h.files) {
      const actual = await readFile(path.join(c.root, file.relativePath)), expectedMain = Buffer.from(h.bytes.toString().replace("old", "final"));
      if (file.role === "main") expect(actual).toEqual(expectedMain);
      else if (file.relativePath === h.manifest) expect(JSON.parse(actual.toString())).toEqual({ ...JSON.parse(file.bytes.toString()), htmlSha256: digest(expectedMain) });
      else expect(actual).toEqual(file.bytes);
      expect(await readFile(path.join(h.revision.root, file.relativePath))).toEqual(file.bytes);
      expect(c.files.find(x => x.relativePath === file.relativePath)!.beforeSha256).toBe(digest(file.bytes));
      expect((await stat(path.join(h.revision.root, file.relativePath))).mode & 0o222).toBe(0);
    }
    expect((await stat(h.revision.root)).mode).toBe(bMode); expect(await state(h.f)).toEqual(before);
    if (c.assetsRelativeRoot) expect(result.outputs[0]!.assetsRoot).toBe(path.join(c.root, c.assetsRelativeRoot));
  }, 20000);
  it.each(["format", "layout"] as const)("rejects unproven historical %s without changing history", async kind => {
    const h = await history("html", kind === "layout" ? "arbitrary" : "local");
    if (kind === "format") {
      delete h.revision.bundleManifestRelativePath; delete h.revision.assetsRelativeRoot;
      await owned.db.update(workflowTransitionEvents).set({ payload: h.issued.applied }).where(eq(workflowTransitionEvents.id, h.issued.appliedId));
    }
    const before = await state(h.f);
    await expect(storeQaCorrection(owned.db, h.measured)).rejects.toMatchObject({
      reason: kind === "format" ? "historical_format_unknown" : "historical_storage_layout_unproven" });
    expect(await state(h.f)).toEqual(before);
  }, 20000);
  it.each(["role", "file", "invalid"] as const)("rejects direct manifest %s edits", async kind => {
    const s = await declared("html");
    s.f.remediations.items = [{ op: "string_replace", file: path.join(s.dir, s.manifest),
      find: kind === "role" ? "research" : kind === "file" ? "source-notes.txt" : "bundle.v1",
      replace: kind === "invalid" ? "" : "different" }]; await official(s.f);
    const m = await measure(s.f), before = await state(s.f);
    await expect(storeQaCorrection(owned.db, m)).rejects.toThrow(); expect(await state(s.f)).toEqual(before);
  }, 20000);
  it("uses selected paths for a fully identified prior even when its historical placement is arbitrary", async () => {
    const h = await history("html-empty", "arbitrary");
    await owned.db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, h.f.preparation.companyId));
    const before = await state(h.f), result = await storeQaCorrection(owned.db, h.measured), r = result.revisions[0]!;
    expect(r.root.startsWith(path.join(root, "missions", h.f.preparation.missionId, "qa-corrections") + "/")).toBe(true);
    expect(r.bundleManifestRelativePath).toBe(h.manifest); expect(r.assetsRelativeRoot).toBe("assets");
    expect(await readFile(result.outputs[0]!.mainPath, "utf8")).toBe("<p>final</p>"); expect(await state(h.f)).toEqual(before);
  }, 20000);
  it("rehashes changed HTML assets and ancillary files without using role aliases as filenames", async () => {
    const s = await declared("html"), file = s.f.remediations.items[0]!.file;
    s.f.remediations.items.push({ op: "string_replace", file: path.join(s.dir, "assets", s.names[0]!), find: s.names[0]!, replace: "pixels" },
      { op: "string_replace", file: path.join(s.dir, "source-notes.txt"), find: "notes", replace: "revised" });
    await official(s.f); const m = await measure(s.f), before = await state(s.f), result = await storeQaCorrection(owned.db, m), r = result.revisions[0]!;
    const manifest = JSON.parse(await readFile(path.join(r.root, s.manifest), "utf8"));
    expect(manifest).toEqual({ schemaVersion: "bundle.v1", htmlSha256: digest("<p>new</p>"),
      assets: [{ fileName: s.names[0], sha256: digest("pixels"), byteSize: 6 }],
      ancillary: [{ role: "research", fileName: "source-notes.txt", sha256: digest("revised"), byteSize: 7 }] });
    expect(await readFile(file, "utf8")).toBe("<p>old</p>"); expect(await state(s.f)).toEqual(before);
  }, 20000);
});
