import path from "node:path";
import fs, { promises as files } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { assets, issueAttachments, issueWorkProducts, qualityActions,
  workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { getStorageService } from "../storage/index.js";
import * as reader from "../services/workflow/control-flow/qa-correction-reader.js";
import * as validation from "../services/workflow/control-flow/qa-correction-commit-validation.js";
import * as qualityUse from "../services/workflow/control-flow/qa-correction-quality-use.js";
import * as evidence from "../services/quality/qa-correction-use-evidence.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection, type StoredCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { commitBuffers, commitDbState, commitFacts, commitFileState, createCommitSourceHarness,
  makeCommitSource, prepareFreshQaOverRevision, type CommitSourceCase, type CommitSourceMode } from "./qa-correction-commit-fixture.js";

// C03 adopted plan §§5,6,8 supplies the oracle: fixture bytes, actual constraints and DB readback.
// QA requests/verdicts are controlled fixtures; every correction issuance below uses the real writer.
describe("C03 atomic correction issuance", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "quality-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  async function stage(quality = false, mode: CommitSourceMode = "content-only", extra = false,
    generation: number | null = null, primary = false) {
    const s = await makeCommitSource(owned.db, owned.root, mode, false, quality);
    await s.db.update(issueWorkProducts).set({ isPrimary: primary }).where(eq(issueWorkProducts.id, s.productId));
    await s.db.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: generation })
      .where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    if (extra) {
      const [pin] = await s.db.insert(workflowStepOutputBindings).values({ companyId: s.p.companyId,
        workflowRunId: s.p.workflowRunId, consumerStepRunId: s.p.producer.stepRunId,
        referencedStepId: s.p.producer.stepId, workProductId: s.productId }).returning();
      s.p.bindings.push({ bindingId: pin!.id, consumer: s.p.producer,
        referencedStepId: s.p.producer.stepId, expectedProductId: s.productId });
    }
    const p = await beginQaCorrection(s.db, s.p);
    if (p.status !== "prepared") throw Error("actual preparation required: " + p.status);
    s.p = p.preparation;
    const measured = await measureQaCorrectionSources(s.db, { preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
    return { s, stored: await storeQaCorrection(s.db, measured) };
  }
  async function state(s: CommitSourceCase) {
    const id = s.p.companyId;
    return { ...await commitDbState(s),
      assets: await s.db.select().from(assets).where(eq(assets.companyId, id)).orderBy(assets.id),
      attachments: await s.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, id)).orderBy(issueAttachments.id),
      actions: await s.db.select().from(qualityActions).where(eq(qualityActions.companyId, id)).orderBy(qualityActions.id) };
  }
  async function nextCorrection(s: CommitSourceCase, issued: reader.IssuedQaCorrection, appliedEventId: string) {
    const next = await prepareFreshQaOverRevision(s, s.db, issued, appliedEventId);
    expect(next.f.qa.id).not.toBe(s.f.qa.id);
    expect(next.f.qa.issueId).not.toBe(s.f.qa.issueId);
    expect(next.request.input.workProductId).toBe(issued.applied.revisions[0]!.workProductId);
    const prepared = await beginQaCorrection(s.db, next.p);
    if (prepared.status !== "prepared") throw Error("next actual preparation required");
    const measured = await measureQaCorrectionSources(s.db, { preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    return storeQaCorrection(s.db, measured);
  }
  it.each(["html", "content", "empty", "content-only"] as const)("issues %s under the real primary constraint and preserves A", async mode => {
    const { s, stored } = await stage(false, mode, false, 0, true), before = await state(s), sourceFiles = await commitFileState(s);
    const [other] = await s.db.insert(issueWorkProducts).values({ companyId: s.p.companyId, issueId: s.p.producer.issueId,
      type: "artifact", title: "unrelated", provider: "local_file", status: "active", externalId: s.file }).returning();
    const [historyPin] = await s.db.insert(workflowStepOutputBindings).values({ companyId: s.p.companyId,
      workflowRunId: s.p.workflowRunId, consumerStepRunId: s.p.producer.stepRunId,
      referencedStepId: s.p.producer.stepId, workProductId: s.productId }).returning();
    const result = await commitQaCorrection(s.db, stored);
    if (result.status !== "committed") throw Error("issuance required");
    const after = await state(s), at = new Date(result.proof.applied.appliedAt), r = stored.revisions[0]!;
    expect(after.products.find(p => p.id === s.productId)).toEqual({ ...before.products[0]!, status: "archived", isPrimary: false, updatedAt: at });
    expect(after.products.find(p => p.id === other!.id)).toEqual(other);
    expect(after.products.find(p => p.id === r.workProductId)).toEqual({ id: r.workProductId,
      companyId: s.p.companyId, issueId: s.p.producer.issueId, projectId: before.products[0]!.projectId,
      type: "artifact", title: "report", provider: "local_file", status: "active", url: null,
      externalId: stored.outputs[0]!.mainPath, metadata: { path: stored.outputs[0]!.mainPath,
        qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1", appliedEventId: result.appliedEventId, revisionId: r.revisionId } },
      createdByRunId: null, sourceExecutionGeneration: null, executionWorkspaceId: null, runtimeServiceId: null,
      reviewState: "none", healthStatus: "unknown", summary: null, isPrimary: true, createdAt: at, updatedAt: at });
    expect(after.products.filter(p => p.isPrimary)).toHaveLength(1);
    expect(after.pins.find(p => p.id === historyPin!.id)).toEqual(historyPin);
    expect(after.pins.find(p => p.id === s.f.bindingId)).toEqual({ ...before.pins[0]!, workProductId: r.workProductId, resolvedAt: at });
    expect(result.proof.followups).toMatchObject([{ operation: "recheck", target: s.p.authority.verdicts[0]!.qa, revisionIds: [r.revisionId] }]);
    expect(after.wakes).toEqual(before.wakes); expect(after.heartbeats).toEqual(before.heartbeats);
    expect(after.usage).toEqual(before.usage); expect(after.groups).toEqual(before.groups);
    const expected = commitBuffers(mode, "new");
    for (const f of r.files) {
      expect(await files.readFile(path.join(r.root, f.relativePath))).toEqual(expected.get(f.relativePath));
      expect(f).toEqual({ ...commitFacts(expected).find(e => e.relativePath === f.relativePath)!,
        beforeSha256: commitFacts(s.files).find(e => e.relativePath === f.relativePath)!.sha256 });
    }
    expect(await commitFileState(s)).toEqual(sourceFiles);
    expect(await reader.readIssuedQaCorrection(s.db, { companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
      appliedEventId: result.appliedEventId })).toEqual(result.proof);
  }, 20000);
  it("issues actual B then C; lost responses and old B never restore a current pin", async () => {
    const { s, stored } = await stage(false, "html"), first = await commitQaCorrection(s.db, stored);
    if (first.status !== "committed") throw Error("actual B required");
    const bState = await state(s);
    expect(await commitQaCorrection(owned.connect(), stored)).toEqual({ ...first, status: "existing", authority: "history_only" });
    expect(await state(s)).toEqual(bState);
    const next = await nextCorrection(s, first.proof, first.appliedEventId), second = await commitQaCorrection(owned.connect(), next);
    if (second.status !== "committed") throw Error("actual C required");
    expect(await files.readFile(next.outputs[0]!.mainPath)).toEqual(commitBuffers("html", "final").get("report.html"));
    expect(second.proof.sourceMeasured.sources[0]!.files).toEqual(commitFacts(commitBuffers("html", "new")));
    await appendQaVerdict(s.db, s.f, "pass");
    const current = await state(s), readBytes = vi.spyOn(validation, "rereadQaCorrectionCommitSources");
    expect(await commitQaCorrection(owned.connect(), stored)).toEqual({ ...first, status: "existing", authority: "history_only" });
    expect(await commitQaCorrection(owned.connect(), next)).toEqual({ ...second, status: "existing", authority: "history_only" });
    expect(readBytes).not.toHaveBeenCalled(); expect(await state(s)).toEqual(current);
    expect(current.pins.find(p => p.id === s.f.bindingId)!.workProductId).toBe(next.revisions[0]!.workProductId);
  }, 20000);
  it("copies input before awaiting and rejects actual external transactions", async () => {
    const { s, stored } = await stage(), copy = structuredClone(stored), pending = commitQaCorrection(s.db, copy);
    copy.revisions[0]!.root = "/changed-after-call"; copy.sourceMeasuredEventId = randomUUID();
    expect((await pending).status).toBe("committed");
    const before = await state(s);
    await s.db.transaction(async tx => {
      await expect(commitQaCorrection(tx as unknown as Db, stored)).rejects.toMatchObject({ reason: "record" });
    });
    expect(await state(s)).toEqual(before);
  }, 20000);
  it("has zero filesystem/storage IO in every transaction and reads issuance in its actual write transaction", async () => {
    const { s, stored } = await stage(true), before = await state(s), transaction = s.db.transaction.bind(s.db);
    let active = 0;
    vi.spyOn(s.db, "transaction").mockImplementation((body, config) => transaction(async tx => {
      active++; try { return await body(tx); } finally { active--; }
    }, config));
    const storage = getStorageService();
    for (const name of ["getObject", "putFile", "headObject", "deleteObject"] as const) {
      const original = storage[name].bind(storage);
      vi.spyOn(storage, name).mockImplementation((...args: unknown[]) => {
        expect(active).toBe(0); return Reflect.apply(original, storage, args);
      });
    }
    for (const name of ["readFile", "open", "stat", "lstat", "realpath", "readdir", "access", "writeFile", "mkdir", "rename", "chmod", "unlink"] as const) {
      const original = files[name];
      vi.spyOn(files, name).mockImplementation((...args: unknown[]) => { expect(active).toBe(0); return Reflect.apply(original, files, args); });
    }
    for (const name of ["createReadStream", "readFileSync", "openSync", "statSync", "writeFileSync"] as const) {
      const original = fs[name];
      vi.spyOn(fs, name).mockImplementation((...args: unknown[]) => { expect(active).toBe(0); return Reflect.apply(original, fs, args); });
    }
    const originalRead = reader.readIssuedQaCorrection;
    const history = vi.spyOn(reader, "readIssuedQaCorrection").mockImplementation(async (db, scope) => {
      expect(active).toBe(1); expect(is(db, PgTransaction)).toBe(true); return originalRead(db, scope);
    });
    const result = await commitQaCorrection(s.db, stored);
    if (result.status !== "committed") throw Error("quality issuance required");
    expect(history).toHaveBeenCalledTimes(1);
    const after = await state(s), receipt = after.receipts.find(r => r.id === result.proof.applied.qualityUseEvidenceRefId)!;
    expect(receipt.qualityContract.verifiedAt).toBe(result.proof.applied.appliedAt);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(after.usage).toEqual(before.usage); expect(after.groups).toEqual(before.groups);
    const events = after.events.filter(e => e.id === result.appliedEventId || result.proof.applied.followupEventIds.includes(e.id));
    expect(events.every(e => e.createdAt.toISOString() === receipt.qualityContract.verifiedAt)).toBe(true);
  }, 20000);
  it.each(["after_use", "before_link", "ordinary"] as const)("preserves timestamp ordering: %s", async fault => {
    const { s, stored } = await stage(fault !== "ordinary"), before = await state(s);
    const measured = Date.parse(stored.sourceMeasured.measuredAt), realCheck = validation.assertQaCorrectionCommitCurrent;
    const realLink = evidence.linkPreparedQaCorrectionUseEvidence;
    let verifiedAt: string | undefined;
    if (fault === "after_use") vi.spyOn(evidence, "linkPreparedQaCorrectionUseEvidence").mockImplementationOnce(async (...args) => {
      const linked = await realLink(...args); verifiedAt = linked.verifiedAt;
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(measured - 1000); return linked;
    });
    else vi.spyOn(validation, "assertQaCorrectionCommitCurrent").mockImplementation(async (...args) => {
      await realCheck(...args);
      if (fault === "before_link") vi.spyOn(Date, "now").mockReturnValue(measured - 1);
      else { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(measured - 1); }
    });
    if (fault === "after_use") {
      const result = await commitQaCorrection(s.db, stored);
      if (result.status !== "committed") throw Error("use-first issuance required");
      expect(result.proof.applied.appliedAt).toBe(verifiedAt);
      expect((await state(s)).products.find(p => p.id === stored.revisions[0]!.workProductId)!.createdAt.toISOString()).toBe(verifiedAt);
    } else {
      await expect(commitQaCorrection(s.db, stored)).rejects.toThrow();
      expect(await state(s)).toEqual(before);
      vi.restoreAllMocks(); vi.useRealTimers();
      expect((await commitQaCorrection(s.db, stored)).status).toBe("committed");
    }
  }, 20000);
});
