import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issueWorkProducts, qualityActions,
  qualityActionGroups, qualityEvidenceRefs, qualityPolicyUsage, qualityPolicyVersions, workflowDefinitions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { beginQaCorrection, withCurrentQaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import * as sourceBytes from "../services/workflow/control-flow/qa-correction-source-bytes.js";
import * as files from "../services/workflow/artifact-files.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { hideCommitDeclaration, prepareFreshQaOverRevision } from "./qa-correction-commit-fixture.js";
import { createQaCorrectionTestDb, issueQaCorrectionFixture, seedQaCorrection, type CorrectionFixture } from "./helpers/qa-correction-fixture.js";
describe("C03/C12 first complete source measurement", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, root: string;
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-measure-"))); }, 120000);
  afterAll(async () => { await owned?.close(); if (root) { execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); } }, 120000);
  const ref = (p: { preparationEventId: string; preparationHash: string }) =>
    ({ preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
  const quality = (f: CorrectionFixture) => { const a = f.preparation.authority;
    if (a.kind !== "quality_current_output") throw Error("quality fixture"); return a; };
  async function state(f: CorrectionFixture) {
    const id = f.preparation.companyId;
    return {
      events: await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, id)).orderBy(asc(workflowTransitionEvents.id)),
      usage: await owned.db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, id)).orderBy(asc(qualityPolicyUsage.id)),
      groups: await owned.db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, id)),
      products: await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, id)).orderBy(asc(issueWorkProducts.id)),
      bindings: await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.companyId, id)),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, id)),
      wakes: await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id)).orderBy(asc(agentWakeupRequests.id)),
    };
  }
  async function seed(mode: "registered_legacy" | "identity" | "sealed" = "registered_legacy", withQuality = false) {
    const f = await seedQaCorrection(owned.db, mode, withQuality), p = f.preparation;
    const dir = path.join(root, "missions", p.missionId, "draft"), file = path.join(dir, "report.html");
    await mkdir(dir, { recursive: true }); await writeFile(file, "old");
    await owned.db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, p.companyId));
    const [product] = await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, f.productId));
    await owned.db.update(issueWorkProducts).set({ url: file, metadata: { ...product!.metadata, path: file } }).where(eq(issueWorkProducts.id, f.productId));
    f.remediations.items[0]!.file = file;
    const v = p.authority.verdicts[0]!, [event] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, v.eventId));
    await owned.db.update(workflowTransitionEvents).set({ payload: { ...event!.payload, remediations: f.remediations } }).where(eq(workflowTransitionEvents.id, v.eventId));
    v.remediationsHash = hashQaCorrectionPayload(f.remediations.items);
    return { f, file, dir };
  }
  async function prepare(f: CorrectionFixture) { const r = await beginQaCorrection(owned.db, f.preparation);
    if (r.status !== "prepared") throw Error("actual first begin required: " + r.status); return r; }
  async function declared(html = false, noAssets?: "content-only" | "invalid-json", historical = false) {
    const s = await seed("identity", noAssets !== undefined), { f, file, dir } = s, p = f.preparation, assetsRoot = path.join(dir, "assets");
    await owned.db.update(issueWorkProducts).set({ type: "artifact" }).where(eq(issueWorkProducts.id, f.productId));
    await mkdir(assetsRoot); const names = historical ? ["x.bin"] : noAssets ? [] : Array.from({ length: html ? 1 : 9 }, (_, i) => `img-${i}.png`);
    for (const name of names) await writeFile(path.join(assetsRoot, name), historical ? "asset" : name);
    const bytes = historical ? Buffer.from("old") : noAssets ? Buffer.from(noAssets === "content-only" ? '{"title":"old"}' : '{"title":"old"')
      : html ? Buffer.from("<p>old</p>") : Buffer.from(JSON.stringify({ schemaVersion: "ContentV1", title: "old", summary: "Draft", tags: ["fixture"],
        blocks: names.map(assetFile => ({ type: "image", assetFile })) }));
    await writeFile(file, bytes);
    if (html) {
      await writeFile(path.join(dir, "source-notes.txt"), "notes");
      await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: "bundle.v1", htmlSha256: files.digest(bytes),
        assets: names.map(fileName => ({ fileName, sha256: files.digest(fileName), byteSize: Buffer.byteLength(fileName) })),
        ancillary: [{ role: "research", fileName: "source-notes.txt", sha256: files.digest("notes"), byteSize: 5 }] }));
    }
    const contract = { role: "qa" as const, resultFileName: "qa.json", resultSchemaVersion: "workflow.qa-result.v1",
      resultAdapter: "generic" as const, inputParams: html ? { html: "html", manifest: "manifest", out: "out" }
        : noAssets === "content-only" ? { content: "content" } : { content: "content", assetsDir: "assets", out: "out" },
      deploymentFiles: ["qa.mjs"], inputEnvelopeVersion: "workflow.artifact-input.v1",
      ...(html ? { bundleManifest: { fileName: "manifest.json", schemaVersion: "bundle.v1", ancillaryRoles: ["research"] } }
        : { assetDiscovery: noAssets || historical ? [] : ["/blocks/*/assetFile"] }) };
    const [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const steps = (definition!.stepsJson as { id: string; [key: string]: unknown }[]).map(step => step.id !== f.qa.stepId ? step : { ...step,
      toolArtifactContract: { role: "qa", schemaVersion: contract.resultSchemaVersion, inputStepId: "produce" },
      workProductSelectors: { produce: { type: "artifact", title: "report" } } });
    await owned.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition!.id));
    const requestId = randomUUID(), artifactExecution = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract },
      step: steps.find(step => step.id === f.qa.stepId), executionGeneration: f.qa.executionGeneration, requestId });
    await owned.db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId, metadata: { artifactExecution } }).where(eq(workflowStepRuns.id, f.qa.id));
    // Real request writer captures the frozen declaration and every selected file.
    const request = await prepareQaArtifactRequest({ db: owned.db, companyId: p.companyId, workflowRunId: p.workflowRunId,
      stepRunId: f.qa.id, stepId: f.qa.stepId, requestId, parameters: html
        ? { html: file, manifest: path.join(dir, "manifest.json") }
        : { content: file, ...(noAssets === "content-only" ? {} : { assets: assetsRoot }) } });
    expect(request).not.toBeNull();
    await owned.db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.qa.id));
    return { ...s, names, bytes, request: request!.snapshot };
  }
  it.each(["registered_legacy", "identity", "sealed"] as const)("preserves %s; actual begin, retry +0, one preparation and measurement", async mode => {
    const { f, file } = await seed(mode, true), r = await prepare(f), before = await state(f);
    const a = await measureQaCorrectionSources(owned.db, ref(r));
    expect(a.sourceMeasured.sources).toEqual([{ productId: f.productId,
      files: [{ role: "main", relativePath: "report.html", sha256: files.digest("old"), byteSize: 3 }] }]);
    expect(await measureQaCorrectionSources(owned.db, ref(r))).toEqual(a);
    const after = await state(f);
    expect(after.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(after.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
    expect({ ...after, events: before.events }).toEqual(before);
    expect(after.usage[0]!.executionAttempts).toBe(1); expect(await readFile(file, "utf8")).toBe("old");
    await writeFile(file, "changed"); await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toThrow();
    expect(await state(f)).toEqual(after);
  });
  it.each([false, true])("preserves every declared file, HTML=%s, independently of QA role aliases", async html => {
    const { f, dir, names } = await declared(html), r = await prepare(f), m = await measureQaCorrectionSources(owned.db, ref(r));
    const expected = ["report.html", ...names.map(name => "assets/" + name), ...(html ? ["manifest.json", "source-notes.txt"] : [])].sort();
    const measured = m.sourceMeasured.sources[0]!.files;
    expect(measured.map(x => x.relativePath).sort()).toEqual(expected);
    for (const file of measured) { const bytes = await readFile(path.join(dir, file.relativePath));
      expect(file.sha256).toBe(files.digest(bytes)); expect(file.byteSize).toBe(bytes.length); }
    expect(measured.filter(x => x.role === "asset")).toHaveLength(html ? 1 : 9);
    if (html) expect(measured.filter(x => x.role === "ancillary").map(x => x.relativePath).sort()).toEqual(["manifest.json", "source-notes.txt"]);
  }, 20000);
  // C12: the request writer supports both inputs; C01 keeps malformed rejected content eligible for rework.
  it.each(["content-only", "invalid-json"] as const)("measures supported %s without asset discovery or extra effects", async mode => {
    const { f, file, bytes, request } = await declared(false, mode), initial = await state(f);
    expect(request.input).toMatchObject({ assetsRoot: mode === "content-only" ? "" : path.join(path.dirname(file), "assets"), assetManifest: [] });
    expect(request.artifactExecution.contract.assetDiscovery).toEqual([]);
    const r = await prepare(f), before = await state(f), a = await measureQaCorrectionSources(owned.db, ref(r));
    expect(a.sourceMeasured.sources).toEqual([{ productId: f.productId, files: [
      { role: "main", relativePath: "report.html", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length }] }]);
    expect(await measureQaCorrectionSources(owned.db, ref(r))).toEqual(a);
    const after = await state(f);
    expect(after.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(after.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
    expect({ ...after, events: before.events }).toEqual(before);
    expect({ ...after, events: initial.events, usage: initial.usage, groups: initial.groups }).toEqual(initial);
    expect(after.usage[0]!.executionAttempts).toBe(1); expect(after.groups[0]!.usage.executionAttempts).toBe(1);
    expect(await readFile(file)).toEqual(bytes);
  }, 20000);
  it.each(["missing", "scope", "root", "product", "seal", "assets", "frozen"] as const)("rejects a declared %s mismatch with no legacy fallback", async kind => {
    const { f, request, dir } = await declared(), r = await prepare(f);
    if (kind === "assets") await writeFile(path.join(dir, "assets", "img-8.png"), "tampered");
    else if (kind === "seal") {
      const s = f.preparation.sources[0]!.provenance; if (s.kind !== "workflow_producer") throw Error("producer");
      await owned.db.update(issueWorkProducts).set({ metadata: { path: path.join(dir, "report.html"),
        workflowProducer: { ...s.workflowProducer, sha256: "ff".repeat(32), byteSize: 3 } } }).where(eq(issueWorkProducts.id, f.productId));
    } else {
      const metadata: Record<string, unknown> = { artifactExecution: request.artifactExecution, toolArtifactRequest: structuredClone(request) };
      if (kind === "missing") delete metadata.toolArtifactRequest;
      if (kind === "scope") metadata.toolArtifactRequest = { ...request, companyId: f.otherCompanyId };
      if (kind === "root") metadata.toolArtifactRequest = { ...request, input: { ...request.input, assetsRoot: root } };
      if (kind === "product") metadata.toolArtifactRequest = { ...request, input: { ...request.input, workProductId: randomUUID() } };
      if (kind === "frozen") metadata.artifactExecution = { ...request.artifactExecution, requestId: randomUUID() };
      await owned.db.update(workflowStepRuns).set({ metadata }).where(eq(workflowStepRuns.id, f.qa.id));
    }
    const before = await state(f); await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toThrow(); expect(await state(f)).toEqual(before);
  }, 20000);
  it.each(["scope", "layer", "type", "payload", "time"] as const)("rejects a malformed existing measured row: %s", async kind => {
    const { f } = await seed(), r = await prepare(f), m = await measureQaCorrectionSources(owned.db, ref(r));
    const patch = kind === "scope" ? { missionId: null } : kind === "layer" ? { layer: "foreign" }
      : kind === "type" ? { eventType: "foreign" } : kind === "time" ? { createdAt: new Date(0) }
        : { payload: { ...m.sourceMeasured, preparationHash: "ff".repeat(32) } };
    await owned.db.update(workflowTransitionEvents).set(patch).where(eq(workflowTransitionEvents.id, m.sourceMeasuredEventId));
    const before = await state(f); await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toMatchObject({ reason: "record" });
    expect(await state(f)).toEqual(before);
  });
  async function priorSource() {
    const s = await declared(false, undefined, true), { f } = s;
    // Historical reader input only. New measurement below must use the actual begin writer.
    const issued = await issueQaCorrectionFixture(owned.db, f), revision = issued.applied.revisions[0]!;
    const dir = path.join(root, "prior", revision.revisionId); await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "report.html"), "new"); await writeFile(path.join(dir, "assets", "x.bin"), "asset");
    issued.measured.sources[0]!.files.push({ role: "asset", relativePath: "assets/x.bin", sha256: files.digest("asset"), byteSize: 5 });
    Object.assign(revision, { root: dir, bundleManifestRelativePath: null, assetsRelativeRoot: "assets" });
    revision.files.push({ role: "asset", relativePath: "assets/x.bin", sha256: files.digest("asset"), byteSize: 5, beforeSha256: files.digest("asset") });
    issued.applied.sourceMeasuredHash = hashQaCorrectionPayload(issued.measured);
    await owned.db.update(workflowTransitionEvents).set({ payload: issued.measured }).where(eq(workflowTransitionEvents.id, issued.measuredId));
    await owned.db.update(workflowTransitionEvents).set({ payload: issued.applied }).where(eq(workflowTransitionEvents.id, issued.appliedId));
    const [product] = await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, issued.workProductId));
    await owned.db.update(issueWorkProducts).set({ metadata: { ...product!.metadata, path: path.join(dir, "report.html") } }).where(eq(issueWorkProducts.id, issued.workProductId));
    const prior = await readIssuedQaCorrection(owned.db, issued.scope);
    const next = await prepareFreshQaOverRevision({ f, root, request: s.request }, owned.db, prior, issued.appliedId, "new", {
      files: new Map([["report.html", await readFile(path.join(dir, "report.html"))], ["assets/x.bin", await readFile(path.join(dir, "assets/x.bin"))]]),
      bundleManifestRelativePath: null, assetsRelativeRoot: "assets" });
    await hideCommitDeclaration({ ...next, db: owned.db });
    return { f: next.f, dir, issued, r: await prepare(next.f) };
  }
  it.each(["valid", "main", "asset", "missing", "role", "path", "size", "count"] as const)("checks prior revision full tuple: %s", async kind => {
    const { f, dir, issued, r } = await priorSource();
    if (kind === "main" || kind === "asset") await writeFile(path.join(dir, kind === "main" ? "report.html" : "assets/x.bin"), "changed");
    if (kind === "missing") await unlink(path.join(dir, "assets/x.bin"));
    const revision = issued.applied.revisions[0]!;
    if (kind === "role") revision.files[1]!.role = "ancillary";
    if (kind === "path") revision.files[1]!.relativePath = "assets/missing.bin";
    if (kind === "size") revision.files[1]!.byteSize++;
    if (kind === "count") revision.files.pop();
    if (["role", "path", "size", "count"].includes(kind)) await owned.db.update(workflowTransitionEvents).set({ payload: issued.applied }).where(eq(workflowTransitionEvents.id, issued.appliedId));
    const before = await state(f);
    if (kind === "valid") { const m = await measureQaCorrectionSources(owned.db, ref(r));
      expect(m.sourceMeasured.sources[0]!.files).toEqual([
        { role: "asset", relativePath: "assets/x.bin", sha256: files.digest("asset"), byteSize: 5 },
        { role: "main", relativePath: "report.html", sha256: files.digest("new"), byteSize: 3 }]); }
    else { await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toThrow(); expect(await state(f)).toEqual(before); }
  });
  it.each(["cancel", "generation", "epoch", "deadline", "policy", "declaration", "source", "root"] as const)("rechecks %s after actual reads with no measured/registration/binding/followup/use/wake effects", async kind => {
    const { f } = await seed("identity", true), r = await prepare(f), read = sourceBytes.readQaCorrectionSourceBytes;
    let expected: Awaited<ReturnType<typeof state>> | undefined;
    const spy = vi.spyOn(sourceBytes, "readQaCorrectionSourceBytes").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      if (kind === "cancel") await owned.db.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, quality(f).actionId));
      if (kind === "generation") await owned.db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.producer.id));
      if (kind === "epoch") await owned.db.update(heartbeatRuns).set({ executionEpoch: 2 }).where(eq(heartbeatRuns.id, f.producerHeartbeatId));
      if (kind === "deadline") await owned.db.update(qualityActionGroups).set({ deadlineAt: new Date(0) }).where(eq(qualityActionGroups.id, quality(f).groupId));
      if (kind === "policy") {
        const [policy] = await owned.db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, quality(f).policyVersionId));
        await owned.db.update(qualityPolicyVersions).set({ definition: { ...policy!.definition, periodEnd: new Date(0).toISOString() } }).where(eq(qualityPolicyVersions.id, quality(f).policyVersionId));
      }
      if (kind === "declaration") await owned.db.update(workflowStepRuns).set({ metadata: { artifactExecution: {} } }).where(eq(workflowStepRuns.id, f.qa.id));
      if (kind === "source") await owned.db.update(issueWorkProducts).set({ url: path.join(root, "other.html") }).where(eq(issueWorkProducts.id, f.productId));
      if (kind === "root") await owned.db.update(companies).set({ workProductRoot: path.join(root, "other") }).where(eq(companies.id, f.preparation.companyId));
      expected = await state(f); return bytes;
    });
    onTestFinished(() => spy.mockRestore());
    await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toThrow(); expect(expected).toBeDefined(); expect(await state(f)).toEqual(expected);
  });
  async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 6000;
    while (!await check()) { if (Date.now() > deadline) throw Error("observable barrier not reached"); await new Promise<void>(resolve => setImmediate(resolve)); } }
  it.each([false, true])("two real DB connections converge iff their bytes match; changed=%s", async changed => {
    const { f, file } = await seed("registered_legacy", true), r = await prepare(f), read = sourceBytes.readQaCorrectionSourceBytes;
    const releases: (() => void)[] = [], gates = [0, 1].map(() => new Promise<void>(resolve => releases.push(resolve)));
    let reads = 0, held = false; const jobs: Promise<unknown>[] = [];
    const spy = vi.spyOn(sourceBytes, "readQaCorrectionSourceBytes").mockImplementation(async (...args) => { const value = await read(...args);
      const index = reads++; await gates[index]; return value; });
    const control = await owned.db.$client.reserve(), observer = await owned.connect().$client.reserve();
    try {
      await control.unsafe("CREATE FUNCTION public.qa_measure_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73006,1); RETURN NEW; END $$");
      await control.unsafe("CREATE TRIGGER qa_measure_gate BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_correction_source_measured') EXECUTE FUNCTION public.qa_measure_gate()");
      await control.unsafe("SELECT pg_advisory_lock(73006,1)"); held = true;
      const settle = (db: typeof owned.db) => Promise.allSettled([measureQaCorrectionSources(db, ref(r))]);
      const first = settle(owned.connect()); jobs.push(first); await until(async () => reads === 1);
      if (changed) await writeFile(file, "different");
      const second = settle(owned.connect()); jobs.push(second); await until(async () => reads === 2); releases[0]!();
      await until(async () => (await observer.unsafe("SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock'")).some(r => /insert into "workflow_transition_events"/i.test(String(r.query))));
      releases[1]!();
      await until(async () => { const rows = await observer.unsafe("SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE wait_event_type = 'Lock'");
        const writer = rows.find(r => /insert into "workflow_transition_events"/i.test(String(r.query)));
        return !!writer && rows.some(r => /quality_policy_usage/.test(String(r.query)) && (r.blockers as number[]).includes(Number(writer.pid))); });
      await control.unsafe("SELECT pg_advisory_unlock(73006,1)"); held = false;
      const [a] = await first, [b] = await second;
      expect(a!.status).toBe("fulfilled"); expect(b!.status).toBe(changed ? "rejected" : "fulfilled");
      if (a!.status === "fulfilled" && b!.status === "fulfilled") expect(b!.value).toEqual(a!.value);
      if (b!.status === "rejected") expect(b!.reason).toMatchObject({ reason: "source" });
      const after = await state(f); expect(after.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
      expect(after.usage[0]!.executionAttempts).toBe(1); expect(after.groups[0]!.usage.executionAttempts).toBe(1);
    } finally {
      releases.forEach(release => release()); if (held) await control.unsafe("SELECT pg_advisory_unlock(73006,1)");
      await Promise.allSettled(jobs); spy.mockRestore();
      await control.unsafe("DROP TRIGGER IF EXISTS qa_measure_gate ON workflow_transition_events");
      await control.unsafe("DROP FUNCTION IF EXISTS public.qa_measure_gate()"); control.release(); observer.release();
    }
  }, 20000);
  it("performs no filesystem work inside actual DB transaction callbacks", async () => {
    const { f } = await seed(), r = await prepare(f), transaction = owned.db.transaction.bind(owned.db);
    let active = 0, reads = 0;
    const tx = vi.spyOn(owned.db, "transaction").mockImplementation((callback, config) => transaction(async t => {
      active++; try { return await callback(t); } finally { active--; } }, config));
    const read = files.readArtifactBytes, capture = files.captureArtifactRoot;
    const a = vi.spyOn(files, "readArtifactBytes").mockImplementation(async (...args) => { expect(active).toBe(0); reads++; return read(...args); });
    const b = vi.spyOn(files, "captureArtifactRoot").mockImplementation(async (...args) => { expect(active).toBe(0); return capture(...args); });
    onTestFinished(() => { tx.mockRestore(); a.mockRestore(); b.mockRestore(); });
    await measureQaCorrectionSources(owned.db, ref(r)); expect(reads).toBeGreaterThan(0);
  });
  it("rejects changed sealed bytes before the first measurement", async () => {
    const { f, file } = await seed("sealed"), r = await prepare(f), before = await state(f);
    await writeFile(file, "bad"); await expect(measureQaCorrectionSources(owned.db, ref(r))).rejects.toMatchObject({ reason: "source" });
    expect(await state(f)).toEqual(before);
  });
  it("rolls back a zero-usage row materialized by a noop recheck", async () => {
    const { f } = await seed("identity", true), r = await prepare(f);
    // Explicit fixture fault exercises the lock helper's zero-row prefix, never a production repair.
    await owned.db.delete(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, f.preparation.companyId));
    const before = await state(f);
    await expect(withCurrentQaCorrectionPreparation(owned.db, r, async () => ({ effect: "noop", value: 1 })))
      .resolves.toEqual({ status: "current", effect: "noop", value: 1 });
    expect(await state(f)).toEqual(before); expect(before.usage).toEqual([]);
  });
  it("rolls back noop prefix writes and propagates the exact ordinary error", async () => {
    const { f } = await seed("identity", true), r = await prepare(f), before = await state(f), error = Error("ordinary");
    const body = async (tx: Parameters<Parameters<typeof withCurrentQaCorrectionPreparation>[2]>[0]) => {
      await tx.update(issueWorkProducts).set({ title: "must rollback" }).where(eq(issueWorkProducts.id, f.productId)); };
    expect(await withCurrentQaCorrectionPreparation(owned.db, r, async tx => { await body(tx); return { effect: "noop", value: "kept" }; }))
      .toEqual({ status: "current", effect: "noop", value: "kept" });
    await expect(withCurrentQaCorrectionPreparation(owned.db, r, async tx => { await body(tx); throw error; })).rejects.toBe(error);
    expect(await state(f)).toEqual(before);
  });
  it("rejects extra proof fields and historical handles before reading bytes", async () => {
    const { f } = await seed("registered_legacy", true), issued = await issueQaCorrectionFixture(owned.db, f), before = await state(f);
    const proof = { preparationEventId: issued.preparation.correctionId, preparationHash: hashQaCorrectionPayload(issued.preparation) };
    const spy = vi.spyOn(sourceBytes, "readQaCorrectionSourceBytes"); onTestFinished(() => spy.mockRestore());
    await expect(measureQaCorrectionSources(owned.db, { ...proof, extra: true } as typeof proof)).rejects.toMatchObject({ reason: "record" });
    await expect(measureQaCorrectionSources(owned.db, proof)).rejects.toMatchObject({ reason: "stale" });
    expect(spy).not.toHaveBeenCalled(); expect(await state(f)).toEqual(before);
  });
});
