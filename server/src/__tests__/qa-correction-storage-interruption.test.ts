import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issueWorkProducts, missions, qualityActions,
  qualityActionGroups, qualityEvidenceRefs, qualityPolicyUsage, qualityPolicyVersions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import * as files from "../services/workflow/artifact-files.js";
import * as writer from "../services/workflow/artifact-writer.js";
import { appendQaVerdict, createQaCorrectionTestDb, seedQaCorrection, type CorrectionFixture } from "./helpers/qa-correction-fixture.js";

describe("C03/C12 storage interruption boundaries", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, root: string;
  beforeAll(async () => {
    owned = await createQaCorrectionTestDb(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-store-interrupt-")));
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
      actions: await owned.db.select().from(qualityActions).where(eq(qualityActions.companyId, id)),
      products: await owned.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, id)).orderBy(asc(issueWorkProducts.id)),
      bindings: await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.companyId, id)),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, id)),
      wakes: await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id)).orderBy(asc(agentWakeupRequests.id)),
    };
  }
  async function seed(multiple = false, quality = false, selected: string | null = root) {
    const f = await seedQaCorrection(owned.db, "registered_legacy", quality), p = f.preparation;
    const dir = path.join(root, "inputs", p.companyId), file = path.join(dir, "report.html");
    await mkdir(dir, { recursive: true }); await writeFile(file, "old");
    await owned.db.update(companies).set({ workProductRoot: selected }).where(eq(companies.id, p.companyId));
    await owned.db.update(issueWorkProducts).set({ url: file, metadata: { path: file } }).where(eq(issueWorkProducts.id, f.productId));
    f.remediations.items[0]!.file = file;
    const v = p.authority.verdicts[0]!, [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, v.eventId));
    await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, remediations: f.remediations } }).where(eq(workflowTransitionEvents.id, v.eventId));
    v.remediationsHash = hashQaCorrectionPayload(f.remediations.items);
    const sourceFiles = [file];
    if (multiple) {
      const second = path.join(dir, "second.txt"); await writeFile(second, "other"); sourceFiles.push(second);
      const [product] = await owned.db.insert(issueWorkProducts).values({ companyId: p.companyId, issueId: p.producer.issueId,
        type: "file", provider: "local_file", title: "second", status: "active", url: second, metadata: { path: second } }).returning();
      p.sources.push({ productId: product!.id, provenance: { kind: "registered_legacy" } });
    }
    const prepared = await beginQaCorrection(owned.db, p);
    if (prepared.status !== "prepared") throw Error("actual first begin required: " + prepared.status);
    const measured = await measureQaCorrectionSources(owned.db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    return { f, dir, file, sourceFiles, measured };
  }
  async function sourceSnapshot(paths: string[]) {
    return Promise.all(paths.map(async file => ({ file, bytes: await readFile(file),
      mode: (await stat(file)).mode, directoryMode: (await stat(path.dirname(file))).mode })));
  }
  async function unchangedSources(snapshot: Awaited<ReturnType<typeof sourceSnapshot>>) {
    for (const old of snapshot) {
      expect(await readFile(old.file)).toEqual(old.bytes); expect((await stat(old.file)).mode).toBe(old.mode);
      expect((await stat(path.dirname(old.file))).mode).toBe(old.directoryMode);
    }
  }
  function oneIssuance(value: Awaited<ReturnType<typeof state>>) {
    expect(value.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(value.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
    expect(value.events.filter(e => ["qa_remediation_applied", "qa_correction_followup_requested"].includes(e.eventType))).toEqual([]);
    expect(value.receipts).toEqual([]);
  }
  it.each(["before", "partial", "readback", "mismatch", "later"] as const)("retries %s failure with fresh candidates, preserving all past bytes", async kind => {
    const s = await seed(kind === "later", true), before = await state(s.f), original = await sourceSnapshot(s.sourceFiles);
    oneIssuance(before); const persist = writer.createArtifactDirectory, read = files.readArtifactBytes, fault = Error("injected storage interruption");
    const targets: { path: string; names: string[] }[] = []; let failed = false;
    const writeSpy = vi.spyOn(writer, "createArtifactDirectory").mockImplementation(async (...args) => {
      targets.push({ path: path.join(args[0].path, args[1]), names: args[2].map(f => f.relative) });
      if (!failed && (kind === "before" || kind === "partial" || (kind === "later" && targets.length === 2))) {
        failed = true;
        if (kind !== "before") await persist(args[0], args[1], [{ ...args[2][0]!, bytes: args[2][0]!.bytes.subarray(0, 1) }], args[3]);
        throw fault;
      }
      return persist(...args);
    });
    const readSpy = vi.spyOn(files, "readArtifactBytes").mockImplementation(async (...args) => {
      const bytes = await read(...args);
      if ((kind === "readback" || kind === "mismatch") && !failed && args[0].path.includes("/qa-corrections/")) {
        failed = true; if (kind === "mismatch") return Buffer.from("bad"); throw fault;
      }
      return bytes;
    });
    onTestFinished(() => { writeSpy.mockRestore(); readSpy.mockRestore(); });
    const attempt = storeQaCorrection(owned.db, s.measured);
    if (kind === "mismatch") await expect(attempt).rejects.toMatchObject({ reason: "source" });
    else await expect(attempt).rejects.toBe(fault);
    expect(failed).toBe(true); expect(await state(s.f)).toEqual(before); await unchangedSources(original);
    const previous = await Promise.all(targets.map(async t => ({
      path: t.path, files: await Promise.all(t.names.map(async name => {
        try { const file = path.join(t.path, name); return { name, bytes: await readFile(file), mode: (await stat(file)).mode }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; }
      })),
    })));
    const result = await storeQaCorrection(owned.db, s.measured);
    expect(result.status).toBe("stored_uncommitted"); expect(result.sourceMeasuredEventId).toBe(s.measured.sourceMeasuredEventId);
    expect(result.preparationEventId).toBe(s.measured.preparationEventId);
    expect(result.revisions).toHaveLength(s.sourceFiles.length);
    for (const old of previous) {
      expect(result.revisions.every(r => r.root !== old.path)).toBe(true);
      for (const file of old.files) if (file) {
        expect(await readFile(path.join(old.path, file.name))).toEqual(file.bytes);
        expect((await stat(path.join(old.path, file.name))).mode).toBe(file.mode);
      }
    }
    for (const r of result.revisions) for (const f of r.files) {
      const actual = await readFile(path.join(r.root, f.relativePath));
      expect(actual.toString()).toBe(r.sourceProductId === s.f.productId ? "new" : "other");
      expect(f.sha256).toBe(files.digest(actual)); expect(f.byteSize).toBe(actual.length);
    }
    expect(await state(s.f)).toEqual(before); await unchangedSources(original);
  }, 20000);
  const changes = ["cancel", "action-cancel", "generation", "authority", "binding", "verdict", "policy", "deadline", "epoch", "measurement"] as const;
  const boundaries = ["read-before", "read-after", "write-before", "write-after", "readback"] as const;
  it.each(boundaries.flatMap(boundary => changes.map(change => ({ boundary, change }))))("never returns success after $change at $boundary", async ({ boundary, change }) => {
    const s = await seed(false, true), p = s.f.preparation, a = p.authority;
    if (a.kind !== "quality_current_output") throw Error("quality fixture");
    const original = await sourceSnapshot(s.sourceFiles); let injected = false, expected: Awaited<ReturnType<typeof state>> | undefined;
    const mutate = async () => {
      if (injected) return; injected = true;
      if (change === "cancel") await owned.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, p.missionId));
      if (change === "action-cancel") await owned.db.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, a.actionId));
      if (change === "generation") await owned.db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, s.f.producer.id));
      if (change === "authority") await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, p.workflowRunId));
      if (change === "binding") await owned.db.update(workflowStepOutputBindings).set({ referencedStepId: "other" }).where(eq(workflowStepOutputBindings.id, s.f.bindingId));
      if (change === "verdict") await appendQaVerdict(owned.db, s.f, "pass");
      if (change === "policy") await owned.db.update(qualityPolicyVersions).set({ disabledAt: new Date(0) }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
      if (change === "deadline") await owned.db.update(qualityActionGroups).set({ deadlineAt: new Date(0) }).where(eq(qualityActionGroups.id, a.groupId));
      if (change === "epoch") await owned.db.update(heartbeatRuns).set({ executionEpoch: 2 }).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId));
      if (change === "measurement") await owned.db.update(workflowTransitionEvents).set({ createdAt: new Date(0) }).where(eq(workflowTransitionEvents.id, s.measured.sourceMeasuredEventId));
      expected = await state(s.f);
    };
    const read = files.readArtifactBytes, persist = writer.createArtifactDirectory;
    const readSpy = vi.spyOn(files, "readArtifactBytes").mockImplementation(async (...args) => {
      const b = args[0].path.includes("/qa-corrections/");
      if (boundary === "read-before" && !b) await mutate();
      const bytes = await read(...args);
      if ((boundary === "read-after" && !b) || (boundary === "readback" && b)) await mutate();
      return bytes;
    });
    const writeSpy = vi.spyOn(writer, "createArtifactDirectory").mockImplementation(async (...args) => {
      if (boundary === "write-before") await mutate();
      const result = await persist(...args);
      if (boundary === "write-after") await mutate();
      return result;
    });
    onTestFinished(() => { readSpy.mockRestore(); writeSpy.mockRestore(); });
    await expect(storeQaCorrection(owned.db, s.measured)).rejects.toThrow();
    expect(injected).toBe(true); expect(expected).toBeDefined(); expect(await state(s.f)).toEqual(expected);
    oneIssuance(await state(s.f)); await unchangedSources(original);
  }, 20000);
  it.each(["missing", "unwritable", "legacy-readonly"] as const)("does not create or bypass a %s selected root", async kind => {
    const selected = path.join(root, "storage-" + randomUUID());
    if (kind === "unwritable") { await mkdir(selected); await chmod(selected, 0o500); }
    const s = await seed(false, false, kind === "legacy-readonly" ? null : selected);
    if (kind === "legacy-readonly") await chmod(s.dir, 0o500);
    const before = await state(s.f), original = await sourceSnapshot(s.sourceFiles);
    const selectedMode = kind === "unwritable" ? (await stat(selected)).mode : null;
    await expect(storeQaCorrection(owned.db, s.measured)).rejects.toThrow();
    expect(await state(s.f)).toEqual(before); oneIssuance(before); await unchangedSources(original);
    if (kind === "missing") await expect(stat(selected)).rejects.toMatchObject({ code: "ENOENT" });
    if (selectedMode !== null) expect((await stat(selected)).mode).toBe(selectedMode);
  });
  it("stores legacy A below its own root when no paths are configured", async () => {
    const s = await seed(false, false, null), before = await state(s.f), original = await sourceSnapshot(s.sourceFiles);
    const result = await storeQaCorrection(owned.db, s.measured);
    expect(result.revisions[0]!.root.startsWith(path.join(s.dir, "qa-corrections", s.f.preparation.correctionId) + "/")).toBe(true);
    expect(await readFile(result.outputs[0]!.mainPath, "utf8")).toBe("new");
    expect(await state(s.f)).toEqual(before); oneIssuance(before); await unchangedSources(original);
  });
  it.each([false, true])("performs all IO outside real transactions and rolls back noop prefixes; missing usage=%s", async missingUsage => {
    const s = await seed(false, true);
    if (missingUsage) await owned.db.delete(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, s.f.preparation.companyId));
    const before = await state(s.f), transaction = owned.db.transaction.bind(owned.db); let active = 0, reads = 0, writes = 0;
    const tx = vi.spyOn(owned.db, "transaction").mockImplementation((callback, config) => transaction(async t => {
      active++; try { return await callback(t); } finally { active--; }
    }, config));
    const read = files.readArtifactBytes, capture = files.captureArtifactRoot, persist = writer.createArtifactDirectory;
    const r = vi.spyOn(files, "readArtifactBytes").mockImplementation(async (...args) => { expect(active).toBe(0); reads++; return read(...args); });
    const c = vi.spyOn(files, "captureArtifactRoot").mockImplementation(async (...args) => { expect(active).toBe(0); return capture(...args); });
    const w = vi.spyOn(writer, "createArtifactDirectory").mockImplementation(async (...args) => { expect(active).toBe(0); writes++; return persist(...args); });
    onTestFinished(() => { tx.mockRestore(); r.mockRestore(); c.mockRestore(); w.mockRestore(); });
    await storeQaCorrection(owned.db, s.measured);
    expect(reads).toBeGreaterThanOrEqual(3); expect(writes).toBe(1); expect(tx.mock.calls).toHaveLength(3);
    expect(await state(s.f)).toEqual(before); oneIssuance(before); if (missingUsage) expect(before.usage).toEqual([]);
  }, 20000);
  it("concurrent stores use distinct complete candidates for the same fixed measurement", async () => {
    const s = await seed(false, true), before = await state(s.f), original = await sourceSnapshot(s.sourceFiles);
    const outcomes = await Promise.allSettled([storeQaCorrection(owned.db, s.measured), storeQaCorrection(owned.connect(), s.measured)]);
    const [a, b] = outcomes;
    expect(outcomes.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
    if (a!.status !== "fulfilled" || b!.status !== "fulfilled") throw Error("both concurrent stores must succeed");
    const first = a.value, second = b.value;
    expect(first.revisions[0]!.root).not.toBe(second.revisions[0]!.root);
    for (const result of [first, second]) {
      expect(result.sourceMeasuredEventId).toBe(s.measured.sourceMeasuredEventId);
      expect(await readFile(result.outputs[0]!.mainPath, "utf8")).toBe("new");
    }
    expect(await state(s.f)).toEqual(before); oneIssuance(before); await unchangedSources(original);
  }, 20000);
  it.each(["type", "time", "payload"] as const)("rejects a forged preparation %s before IO", async kind => {
    const s = await seed(), patch = kind === "type" ? { eventType: "forged" } : kind === "time"
      ? { createdAt: new Date(0) } : { payload: { ...s.f.preparation, dispatchAuthorityVersion: 9 } };
    await owned.db.update(workflowTransitionEvents).set(patch).where(eq(workflowTransitionEvents.id, s.measured.preparationEventId));
    const before = await state(s.f), spy = vi.spyOn(files, "readArtifactBytes"); onTestFinished(() => spy.mockRestore());
    await expect(storeQaCorrection(owned.db, s.measured)).rejects.toMatchObject({ reason: "record" });
    expect(spy).not.toHaveBeenCalled(); expect(await state(s.f)).toEqual(before);
  });
  it.each(["sha", "size", "path", "extra"] as const)("compares actual A to every fixed measured tuple: %s", async kind => {
    const s = await seed(), m = s.measured, file = m.sourceMeasured.sources[0]!.files[0]!;
    if (kind === "sha") file.sha256 = "ff".repeat(32);
    if (kind === "size") file.byteSize++;
    if (kind === "path") file.relativePath = "other.html";
    if (kind === "extra") m.sourceMeasured.sources[0]!.files.push({ ...file, role: "ancillary", relativePath: "extra.txt" });
    m.sourceMeasuredHash = hashQaCorrectionPayload(m.sourceMeasured);
    await owned.db.update(workflowTransitionEvents).set({ payload: m.sourceMeasured }).where(eq(workflowTransitionEvents.id, m.sourceMeasuredEventId));
    const before = await state(s.f), original = await sourceSnapshot(s.sourceFiles);
    await expect(storeQaCorrection(owned.db, m)).rejects.toMatchObject({ reason: "source" });
    expect(await state(s.f)).toEqual(before); await unchangedSources(original);
  });
  it("detects changed A after B storage and never rebases the same measurement", async () => {
    const s = await seed(), before = await state(s.f), read = files.readArtifactBytes; let changed = false;
    const spy = vi.spyOn(files, "readArtifactBytes").mockImplementation(async (...args) => {
      const bytes = await read(...args);
      if (!changed && args[0].path.includes("/qa-corrections/")) { changed = true; await writeFile(s.file, "external change"); }
      return bytes;
    });
    onTestFinished(() => spy.mockRestore());
    await expect(storeQaCorrection(owned.db, s.measured)).rejects.toMatchObject({ reason: "source" });
    expect(changed).toBe(true); expect(await readFile(s.file, "utf8")).toBe("external change");
    await expect(storeQaCorrection(owned.db, s.measured)).rejects.toMatchObject({ reason: "source" });
    expect(await state(s.f)).toEqual(before); oneIssuance(before);
  });
});
