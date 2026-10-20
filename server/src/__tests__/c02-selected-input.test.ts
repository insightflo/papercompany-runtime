import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  heartbeatRuns,
  issues,
  issueWorkProducts,
  workflowDefinitions,
  workflowRuns,
  workflowStepOutputBindings,
  workflowStepRuns,
} from "@paperclipai/db";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import type { QaRequest } from "../services/workflow/qa-artifact-request.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";
import { PgSelectBase } from "drizzle-orm/pg-core";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { commitDbState, commitFileState, makeCommitSource } from "./qa-correction-commit-fixture.js";
import { appendQaVerdict, attempt } from "./helpers/qa-correction-fixture.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, issueC02, issueNextC02,
  type C02Case } from "./helpers/c02-fixture.js";


// C02 stage6/C12 expectation sources: the adopted extraction map,
// workflow-tool-step-args (ancestor/assets and metadata), and workflow-qa-receipt.
// This observes ordinary selected-input capture, not corrected-B delivery/consumption.
it("renders selected input into the real QA request without restamping its producer", async () => {
  const db = database(), f = await fixture();
  const pinScope = and(
    eq(workflowStepOutputBindings.companyId, f.companyId),
    eq(workflowStepOutputBindings.workflowRunId, f.runId),
    eq(workflowStepOutputBindings.consumerStepRunId, f.qaId),
  );
  const readPins = () => db.select().from(workflowStepOutputBindings).where(pinScope);
  const initialPins = await readPins();
  // fixture:64-65 resolves once. Remove only that fixture-owned pin so this
  // invocation must perform real selection and a first pin, rather than reuse it.
  expect(initialPins).toHaveLength(1);
  expect(initialPins[0].referencedStepId).toBe("write");
  await db.delete(workflowStepOutputBindings).where(and(pinScope,
    eq(workflowStepOutputBindings.id, initialPins[0].id)));
  expect(await readPins()).toEqual([]);

  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, f.companyId),
    eq(issueWorkProducts.type, "document"),
    eq(issueWorkProducts.title, "content.json"),
  ));
  expect(products).toHaveLength(1);
  const product = products[0];
  expect(product.metadata?.path).toBe(f.content);
  expect(initialPins[0].workProductId).toBe(product.id);
  const [producer] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write"),
  ));
  expect(producer.executionGeneration).toBe(1);
  expect(product.issueId).toBe(producer.issueId);
  const registeredProducer = product.metadata?.workflowProducer;
  expect(registeredProducer).toMatchObject({
    companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId,
    stepRunId: producer.id, stepId: "write", executionGeneration: 1,
    retryCount: producer.retryCount, iterationIndex: producer.iterationIndex,
  });

  const [beforeRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  await db.update(workflowRuns).set({ metadata: { ...beforeRun.metadata,
    section: "tech-blog", workflowChildInputs: { edition: "stage6" },
  } }).where(eq(workflowRuns.id, f.runId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  const workflowSteps = definition.stepsJson as Parameters<typeof resolveWorkflowToolStepArgs>[0]["workflowSteps"];
  const qa = workflowSteps.find(step => step.id === "qa");
  if (!qa) throw new Error("QA fixture definition is missing its consumer");
  expect(qa.workProductSelectors).toEqual({ write: { type: "document", title: "content.json" } });
  const [beforeQa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(beforeQa.executionGeneration).toBe(2);
  expect(beforeQa.metadata.toolArtifactRequest).toBeUndefined();

  const parameters = await resolveWorkflowToolStepArgs({
    db, run, consumerStepRunId: f.qaId, workflowSteps,
    step: { ...qa, toolArgs: {
      content: "{$steps.write.workProductPath}",
      assetsDir: "{$steps.write.siblingAssetsDir}",
      section: "{$runMetadata.section}",
      edition: "{$childInputs.edition}",
    } },
  });
  // These literal expectations come from the fixture's paths and declared inputs,
  // not from rendering helpers or another selector invocation.
  expect(parameters).toEqual({
    content: f.content, assetsDir: f.assetsDir, section: "tech-blog", edition: "stage6",
  });
  const pins = await readPins();
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({
    companyId: f.companyId, workflowRunId: f.runId, consumerStepRunId: f.qaId,
    referencedStepId: "write", workProductId: product.id, sourceExecutionGeneration: 1,
  });
  expect(pins[0].id).not.toBe(initialPins[0].id);

  // Only the external QA producer is the fixture's deterministic machine double.
  // Pass the resolver's exact return value through the actual core executor.
  const result = await executeCoreWorkflowTool({
    db, companyId: f.companyId, toolName: "local-qa", workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: "qa", requestId: f.requestId, parameters,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const [savedQa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(savedQa.metadata.toolArtifactRequest).toBeDefined();
  const request = savedQa.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const [contentBytes, assetBytes] = await Promise.all([
    readFile(f.content), readFile(path.join(f.assetsDir, "hero.png")),
  ]);
  const contentSha256 = createHash("sha256").update(contentBytes).digest("hex");
  const assetManifest = [{
    fileName: "hero.png",
    sha256: createHash("sha256").update(assetBytes).digest("hex"),
    byteSize: assetBytes.length,
  }];
  expect(request).toMatchObject({
    companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: "qa", executionGeneration: 2, requestId: f.requestId,
  });
  expect(request.input).toEqual({
    workProductId: product.id, producer: registeredProducer, path: f.content,
    sha256: contentSha256, byteSize: contentBytes.length,
    assetsRoot: f.assetsDir, assetManifest,
  });
  expect(await readFile(path.join(request.outputRoot, "input", "content.json"))).toEqual(contentBytes);
  expect(await readFile(path.join(request.outputRoot, "input", "assets", "hero.png"))).toEqual(assetBytes);
  expect(result.toolArtifactReceipt?.input).toEqual(request.input);
  expect(await readPins()).toEqual(pins);
});

// C02-9A/C12: real issuance, independent fixture bytes and peer SQL. B capture is stage9B.
describe("C02 corrected selected inputs", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "selection-quality-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  const scope = (c: Pick<C02Case, "s">, pinnedId?: string) => ({ companyId: c.s.p.companyId,
    workflowRunId: c.s.p.workflowRunId, stepId: "produce", selector: { type: "artifact", title: "report" }, pinnedId });
  const state = (c: Pick<C02Case, "s" | "peer">) => commitDbState({ ...c.s, db: c.peer });
  async function args(c: Pick<C02Case, "s" | "peer">, db = c.peer, consumerStepRunId = c.s.f.qa.id) {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, c.s.p.workflowRunId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const workflowSteps = definition!.stepsJson as Parameters<typeof resolveWorkflowToolStepArgs>[0]["workflowSteps"];
    const [consumer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, consumerStepRunId));
    const qa = workflowSteps.find(s => s.id === consumer!.stepId)!;
    return resolveWorkflowToolStepArgs({ db, run: run!, consumerStepRunId, workflowSteps,
      step: { ...qa, workProductSelectors: { produce: scope(c).selector },
        toolArgs: { content: "{$steps.produce.workProductPath}" } } });
  }
  // The same issued B previously failed provenance_missing; C02 requires B plus A's unchanged producer.
  it("selects actual B and C with the entire original producer, preserving the existing pin", async () => {
    const b = await issueC02(owned), r = b.applied.revisions[0]!, expected = commitBuffers("html", "new");
    // A non-null existing generation must survive even though B has no source generation.
    await b.peer.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: b.s.producer.executionGeneration })
      .where(eq(workflowStepOutputBindings.id, b.s.f.bindingId));
    const before = await state(b), selected = await selectOfficialWorkProduct(b.peer, scope(b));
    expect(selected.product.id).toBe(r.workProductId);
    expect(selected.file).toBe(path.join(r.root, "report.html"));
    expect(selected.producer).toEqual(b.s.producer);
    expect(selected.producer.sha256).toBe(commitFacts(commitBuffers("html", "old")).find(f => f.role === "main")!.sha256);
    expect(selected.producer.byteSize).toBe(commitBuffers("html", "old").get("report.html")!.length);
    expect(selected.product.metadata?.workflowProducer).toBeUndefined();
    expect(selected.product.sourceExecutionGeneration).toBeNull();
    if (!("correction" in selected) || !selected.correction) throw Error("issued revision evidence required");
    expect(selected.correction.candidates.map(c => c.ref)).toEqual([b.ref]);
    expect(selected.correction.revision.ancillaryRoleBindings).toEqual([{ role: "research", relativePath: "source-notes.txt" }]);
    const facts = selected.correction.revision.files.map(({ beforeSha256: _, ...f }) => f);
    expect(facts.sort((a, z) => a.relativePath.localeCompare(z.relativePath)))
      .toEqual(commitFacts(expected).sort((a, z) => a.relativePath.localeCompare(z.relativePath)));
    for (const [name, bytes] of expected) expect(await readFile(path.join(r.root, name))).toEqual(bytes);
    expect(await args(b)).toEqual({ content: path.join(r.root, "report.html") });
    expect(await state(b)).toEqual(before);
    expect(before.pins.find(p => p.id === b.s.f.bindingId)).toMatchObject({
      workProductId: r.workProductId, sourceExecutionGeneration: b.s.producer.executionGeneration,
    });
    const c = await issueNextC02(b), cr = c.applied.revisions[0]!;
    await expect(selectOfficialWorkProduct(b.peer, scope(b, r.workProductId))).rejects.toThrow();
    const current = await selectOfficialWorkProduct(c.peer, scope(c));
    expect(current.product.id).toBe(cr.workProductId);
    expect(current.producer).toEqual(b.s.producer);
    expect(await readFile(current.file)).toEqual(commitBuffers("html", "final").get("report.html"));
    expect(await args(c)).toEqual({ content: path.join(cr.root, "report.html") });
    const after = await state(c);
    const expectedPins = [...before.pins.map(p => ({ ...p, workProductId: cr.workProductId,
      resolvedAt: after.pins.find(a => a.id === p.id)!.resolvedAt })), {
      id: c.s.f.bindingId, companyId: c.s.p.companyId, workflowRunId: c.s.p.workflowRunId,
      consumerStepRunId: c.s.f.qa.id, referencedStepId: c.s.p.producer.stepId,
      workProductId: cr.workProductId, sourceExecutionGeneration: c.s.producer.executionGeneration,
      createdAt: expect.any(Date), resolvedAt: expect.any(Date),
    }].sort((a, z) => a.id.localeCompare(z.id));
    expect(after.pins).toEqual(expectedPins);
  }, 20000);
  it.each(["malformed", "legacy", "cancel", "binding"] as const)("refuses %s without changing pins or issuing proof", async fault => {
    const c = await issueC02(owned, { mode: "content-only", legacy: fault === "legacy" });
    if (fault === "malformed") await c.peer.update(issueWorkProducts).set({ metadata: {
      path: path.join(c.applied.revisions[0]!.root, "report.html"), qaCorrection: null,
      workflowProducer: c.s.producer } }).where(eq(issueWorkProducts.id, c.applied.revisions[0]!.workProductId));
    if (fault === "cancel") await c.peer.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, c.s.p.workflowRunId));
    if (fault === "binding") await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId })
      .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
    const before = await state(c);
    await expect(selectOfficialWorkProduct(c.peer, scope(c))).rejects.toThrow();
    await expect(args(c)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
  }, 20000);
  it("locks the root quality prefix first, reuses its last use and adds no late locks in a nested call", async () => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), before = await state(c);
    const locks = vi.spyOn(PgSelectBase.prototype, "for");
    expect(await args(c)).toEqual({ content: path.join(c.applied.revisions[0]!.root, "report.html") });
    const tables = locks.mock.contexts.map(q => (q as { toSQL(): { sql: string } }).toSQL().sql
      .match(/from "([^"]+)"/)?.[1]);
    expect(tables).toEqual([
      "quality_policy_usage", "quality_action_groups", "quality_actions", "quality_policy_versions",
      "missions", "workflow_runs", "heartbeat_runs", "issues", "workflow_step_runs",
      "issue_work_products", "workflow_step_output_bindings",
    ]);
    locks.mockClear();
    await c.peer.transaction(async tx => {
      expect(await args(c, tx as unknown as typeof c.peer)).toEqual({
        content: path.join(c.applied.revisions[0]!.root, "report.html"),
      });
    });
    expect(locks).not.toHaveBeenCalled();
    await expect(args(c, c.peer, c.s.f.producer.id)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
  }, 20000);
  it("keeps QA1 on issued B when only QA2 retries, and rejects QA2 without side effects", async () => {
    const s = await makeCommitSource(owned.db, owned.root, "content-only"), p = s.p;
    const c = { s, peer: owned.connect() }, [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [hb] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    const [issue] = await owned.db.insert(issues).values({ companyId: p.companyId, missionId: p.missionId,
      title: "[QA] Second", status: "todo", originKind: "workflow_execution" }).returning();
    const [qa] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId,
      stepId: "qa-2", issueId: issue!.id, status: "failed" }).returning();
    await owned.db.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson,
      { id: qa!.stepId, name: "Second QA", agentId: hb!.agentId, dependencies: ["produce"] }] })
      .where(eq(workflowDefinitions.id, definition!.id));
    const remediations = { items: [{ op: "string_replace" as const, file: s.file, find: "Draft", replace: "Reviewed" }] };
    const verdict = await appendQaVerdict(owned.db,
      { ...s.f, qa: qa!, remediations }, "request_changes");
    p.authority.verdicts.unshift(verdict);
    const [pin] = await owned.db.insert(workflowStepOutputBindings).values({ companyId: p.companyId, workflowRunId: p.workflowRunId,
      consumerStepRunId: qa!.id, referencedStepId: "produce", workProductId: s.productId,
      sourceExecutionGeneration: s.producer.executionGeneration }).returning();
    p.bindings.push({ bindingId: pin!.id, consumer: attempt(qa!), referencedStepId: "produce", expectedProductId: s.productId });
    const originalPins = (await state(c)).pins, prepared = await beginQaCorrection(owned.db, p);
    if (prepared.status !== "prepared") throw Error("real two-target preparation required: " + prepared.status);
    const measured = await measureQaCorrectionSources(owned.db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    const stored = await storeQaCorrection(owned.db, measured), issued = await commitQaCorrection(owned.db, stored);
    if (issued.status !== "committed") throw Error("real two-target issuance required: " + issued.status);
    const r = issued.proof.applied.revisions[0]!;
    expect(issued.proof.followups.map(f => f.target.stepRunId)).toEqual([qa!.id, s.f.qa.id]);
    expect(new Set(issued.proof.followups.map(f => f.requestId)).size).toBe(2);
    expect((await state(c)).pins).toEqual(originalPins.map(p => ({ ...p,
      workProductId: r.workProductId, resolvedAt: expect.any(Date) })));
    await owned.db.update(workflowStepRuns).set({ retryCount: qa!.retryCount + 1 }).where(eq(workflowStepRuns.id, qa!.id));
    const files = new Map([["report.html", Buffer.from('{"schemaVersion":"ContentV1","title":"new","summary":"Reviewed","tags":["fixture"],"blocks":[]}')]]);
    const snapshot = async () => ({ ...await state(c), steps: await c.peer.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, p.workflowRunId)).orderBy(workflowStepRuns.id),
      files: await commitFileState({ ...s, bundles: [...s.bundles, { directory: r.root, files }] }) });
    const before = await snapshot();
    expect(await args(c)).toEqual({ content: path.join(r.root, "report.html") });
    await expect(args(c, c.peer, qa!.id)).rejects.toThrow("qa_correction_followup_attempt");
    const selected = await selectOfficialWorkProduct(c.peer, scope(c));
    expect(selected.product.id).toBe(r.workProductId);
    expect(selected.producer).toEqual(s.producer);
    expect(await snapshot()).toEqual(before);
  }, 20000);
  it("aborts when B changes to C between root classification and the transaction", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), transaction = b.peer.transaction.bind(b.peer);
    let c: C02Case | undefined;
    vi.spyOn(b.peer, "transaction").mockImplementationOnce(async (body, config) => {
      c = await issueNextC02(b);
      return transaction(body, config);
    });
    await expect(args(b)).rejects.toThrow("workproduct_selector_correction_selection_changed");
    if (!c) throw Error("peer C issuance must precede the selection transaction");
    expect(await args(c)).toEqual({ content: path.join(c.applied.revisions[0]!.root, "report.html") });
  }, 20000);
});
