import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { PgSelectBase } from "drizzle-orm/pg-core";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, workflowDefinitions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commitBuffers, commitFacts, createCommitSourceHarness, issueC02, issueNextC02,
  type C02Case } from "./helpers/c02-fixture.js";
import { commitDbState, makeCommitSource } from "./qa-correction-commit-fixture.js";
import { attempt } from "./helpers/qa-correction-fixture.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { hashQaCorrectionPayload, parseQaCorrectionEventPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import * as followups from "../services/workflow/control-flow/qa-correction-followup.js";
import * as bundles from "../services/workflow/qa-html-input.js";

// C02-9B: controlled same-counter dispatch, actual C03 issuance and real request writer.
// Independent fixture bytes + peer SQL + captured files are the oracle, never declared request input.
describe("C02 corrected QA request capture", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "request-quality-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  async function step(c: Pick<C02Case, "s" | "peer">) {
    return (await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id)))[0]!;
  }
  async function preserved(c: Pick<C02Case, "s" | "peer">) {
    return { request: (await step(c)).metadata.toolArtifactRequest,
      pins: await c.peer.select().from(workflowStepOutputBindings)
        .where(eq(workflowStepOutputBindings.workflowRunId, c.s.p.workflowRunId)).orderBy(workflowStepOutputBindings.id) };
  }
  async function ready(c: Pick<C02Case, "s" | "peer">) {
    const { s } = c, [run] = await c.peer.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
    const [definition] = await c.peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const workflowSteps = definition!.stepsJson as Parameters<typeof resolveWorkflowToolStepArgs>[0]["workflowSteps"];
    const qa = workflowSteps.find(s => s.id === c.s.f.qa.stepId)!;
    const requestId = "c02-tool:" + randomUUID(), current = await step(c);
    const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: s.request.artifactExecution.contract },
      step: qa, executionGeneration: current.executionGeneration, requestId });
    if (!frozen) throw Error("controlled frozen QA required");
    await c.peer.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId,
      metadata: { ...current.metadata, artifactExecution: frozen } }).where(eq(workflowStepRuns.id, current.id));
    await c.peer.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: s.producer.executionGeneration })
      .where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    const toolArgs = s.mode === "html"
      ? { html: "{$steps.produce.workProductPath}", manifest: "{$steps.produce.workProductDir}/bundle-index.json" }
      : { content: "{$steps.produce.workProductPath}",
        ...(s.mode === "content-only" ? {} : { assets: "{$steps.produce.siblingAssetsDir}" }) };
    const parameters = await resolveWorkflowToolStepArgs({ db: s.db, run: run!, consumerStepRunId: current.id,
      workflowSteps, step: { ...qa, toolArgs } });
    return { db: s.db, companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
      stepRunId: current.id, stepId: current.stepId, requestId, artifactExecution: frozen, parameters };
  }
  async function prepare(input: Awaited<ReturnType<typeof ready>>) {
    const result = await prepareQaArtifactRequest(input);
    if (!result) throw Error("actual QA request required");
    return result;
  }
  async function files(root: string, prefix = ""): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) found.push(...await files(root, name));
      else found.push(name);
    }
    return found.sort();
  }
  it.each(["html", "content", "content-only"] as const)("captures all issued %s files and preserves the entire A producer", async mode => {
    const c = await issueC02(owned, { mode, quality: mode === "content-only" }), input = await ready(c);
    const r = c.applied.revisions[0]!, expected = commitBuffers(mode, "new"), facts = commitFacts(expected);
    const main = facts.find(f => f.role === "main")!, old = commitFacts(commitBuffers(mode, "old")).find(f => f.role === "main")!;
    const before = await preserved(c), beforeDb = await commitDbState({ ...c.s, db: c.peer });
    const locks = vi.spyOn(PgSelectBase.prototype, "for");
    let result: Awaited<ReturnType<typeof prepare>>;
    if (mode === "html") {
      const [[primary], [peer]] = await Promise.all([input.db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`,
        c.peer.$client<{ pid: number }[]>`select pg_backend_pid() as pid`]);
      expect(peer!.pid).not.toBe(primary!.pid);
      const actual = followups.observeQaCorrectionFollowup;
      let observations = 0, release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const observer = vi.spyOn(followups, "observeQaCorrectionFollowup").mockImplementation(async (...args) => {
        const token = await actual(...args).finally(() => {
          if (++observations === 2) release();
        });
        await barrier;
        return token;
      });
      try {
        const [first, second] = await Promise.allSettled([prepare(input), prepare({ ...input, db: c.peer })]);
        if (first.status === "rejected") throw first.reason;
        if (second.status === "rejected") throw second.reason;
        result = first.value;
        expect(second.value.snapshot).toEqual(result.snapshot);
        expect(second.value.snapshot.outputRoot).toBe(result.snapshot.outputRoot);
        expect(second.value.snapshot.qaCorrectionFollowup).toEqual(c.ref);
        expect(observations).toBe(3);
      } finally { observer.mockRestore(); }
    } else result = await prepare(input);
    const tables = locks.mock.contexts.map(q => (q as { toSQL(): { sql: string } }).toSQL().sql.match(/from "([^"]+)"/)?.[1]);
    if (mode === "content-only") expect(tables.slice(0, 11)).toEqual([
      "quality_policy_usage", "quality_action_groups", "quality_actions", "quality_policy_versions",
      "missions", "workflow_runs", "heartbeat_runs", "issues", "workflow_step_runs",
      "issue_work_products", "workflow_step_output_bindings",
    ]);
    const assetManifest = facts.filter(f => f.role === "asset").map(f => ({
      fileName: path.posix.relative("assets", f.relativePath), sha256: f.sha256, byteSize: f.byteSize }));
    const expectedInput = { workProductId: r.workProductId, producer: c.s.producer,
      path: path.join(r.root, "report.html"), sha256: main.sha256, byteSize: main.byteSize,
      assetsRoot: mode === "content" ? path.join(r.root, "assets") : "", assetManifest,
      ...(mode === "html" ? { mode: "html", htmlManifest: { path: path.join(r.root, "bundle-index.json"),
        sha256: facts.find(f => f.relativePath === "bundle-index.json")!.sha256,
        byteSize: expected.get("bundle-index.json")!.length },
        ancillaryManifest: [{ fileName: "research", sha256: facts.find(f => f.relativePath === "source-notes.txt")!.sha256,
          byteSize: expected.get("source-notes.txt")!.length }] } : {}) };
    expect(input.parameters).toEqual(mode === "html"
      ? { html: expectedInput.path, manifest: path.join(r.root, "bundle-index.json") }
      : { content: expectedInput.path, ...(mode === "content-only" ? {} : { assets: path.join(r.root, "assets") }) });
    expect(result.snapshot.input).toEqual(expectedInput);
    expect(result.snapshot.input.producer).toMatchObject({ sha256: old.sha256, byteSize: old.byteSize });
    expect(result.snapshot.qaCorrectionFollowup).toEqual(c.ref);
    expect(result.snapshot.requestId).toBe(input.requestId);
    expect(input.requestId).not.toBe(c.ref.requestId);
    expect((await step(c)).metadata.toolArtifactRequest).toEqual(result.snapshot);
    expect((await preserved(c)).pins).toEqual(before.pins);
    expect(before.pins.find(p => p.id === c.s.f.bindingId)).toMatchObject({
      id: c.s.f.bindingId, workProductId: r.workProductId, sourceExecutionGeneration: c.s.producer.executionGeneration,
    });
    const captured = new Map([...expected].map(([name, bytes]) => [
      name === "source-notes.txt" ? "ancillary/research" : name, bytes,
    ]));
    expect(await files(path.join(result.snapshot.outputRoot, "input"))).toEqual([...captured.keys()].sort());
    for (const [name, bytes] of captured) expect(await readFile(path.join(result.snapshot.outputRoot, "input", name))).toEqual(bytes);
    if (mode === "html") expect(result.parameters.manifest).toBe(path.join(result.snapshot.outputRoot, "input/bundle-index.json"));
    const envelope = JSON.parse(result.inputBytes.toString());
    expect(Buffer.from(envelope.content.base64, "base64")).toEqual(expected.get("report.html"));
    const [product] = await c.peer.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, r.workProductId));
    expect(product!.metadata?.workflowProducer).toBeUndefined();
    expect(product!.sourceExecutionGeneration).toBeNull();
    expect(await commitDbState({ ...c.s, db: c.peer })).toEqual(beforeDb);
    expect((await prepare(input)).snapshot).toEqual(result.snapshot);
  }, 30000);
  it("chooses QA1's exact followup when the historical first candidate belongs to retried QA2", async () => {
    const s = await makeCommitSource(owned.db, owned.root, "content-only"), db = s.db, p = s.p, peer = owned.connect();
    const [run] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [hb] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    const [issue] = await db.insert(issues).values({ companyId: p.companyId, missionId: p.missionId,
      title: "[QA] Other", status: "todo", originKind: "workflow_execution" }).returning();
    const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId,
      stepId: "qa-other", issueId: issue!.id, status: "failed" }).returning();
    await db.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson,
      { id: qa!.stepId, name: "Other QA", agentId: hb!.agentId, dependencies: ["produce"] }] })
      .where(eq(workflowDefinitions.id, definition!.id));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: p.companyId,
      agentId: hb!.agentId, source: "workflow.dispatch", workflowStepRunId: qa!.id }).returning();
    const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId: p.companyId,
      agentId: hb!.agentId, issueId: issue!.id, wakeupRequestId: wake!.id, status: "succeeded" }).returning();
    const remediations = { items: [{ op: "string_replace" as const, file: s.file, find: "Draft", replace: "Reviewed" }] };
    await recordWorkflowValidationVerdict({ db, issue: issue!, source: "workflow_api", verdict: "request_changes",
      heartbeatRunId: heartbeat!.id, remediations });
    const [event] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeat!.id));
    p.authority.verdicts.unshift({ eventId: event!.id, heartbeatRunId: heartbeat!.id, qa: attempt(qa!),
      remediationsHash: hashQaCorrectionPayload(remediations.items) });
    const [pin] = await db.insert(workflowStepOutputBindings).values({ companyId: p.companyId, workflowRunId: p.workflowRunId,
      consumerStepRunId: qa!.id, referencedStepId: "produce", workProductId: s.productId }).returning();
    p.bindings.push({ bindingId: pin!.id, consumer: attempt(qa!), referencedStepId: "produce", expectedProductId: s.productId });
    const prepared = await beginQaCorrection(db, p);
    if (prepared.status !== "prepared") throw Error("real two-consumer preparation required");
    s.p = prepared.preparation;
    const measured = await measureQaCorrectionSources(db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    const stored = await storeQaCorrection(db, measured), result = await commitQaCorrection(db, stored);
    if (result.status !== "committed") throw Error("real two-consumer issuance required");
    const [appliedRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.appliedEventId));
    const applied = parseQaCorrectionEventPayload("qa_remediation_applied", appliedRow!.payload);
    const rows = await peer.select().from(workflowTransitionEvents).where(inArray(workflowTransitionEvents.id, applied.followupEventIds));
    const candidates = rows.map(row => ({ row, value: parseQaCorrectionEventPayload("qa_correction_followup_requested", row.payload) }));
    const selected = candidates.find(c => c.value.target.stepRunId === s.f.qa.id)!;
    expect(result.proof.followups[0]!.target.stepRunId).toBe(qa!.id);
    expect(selected.value.requestId).not.toBe(result.proof.followups[0]!.requestId);
    await peer.update(workflowStepRuns).set({ retryCount: qa!.retryCount + 1 }).where(eq(workflowStepRuns.id, qa!.id));
    const c: C02Case = { s, peer, stored, appliedRow: appliedRow!, applied,
      followupRow: selected.row, followup: selected.value, ref: { companyId: p.companyId,
        workflowRunId: p.workflowRunId, appliedEventId: appliedRow!.id, requestId: selected.value.requestId } };
    const input = await ready(c), before = await preserved(c), request = await prepare(input);
    expect(request.snapshot.qaCorrectionFollowup).toEqual(c.ref);
    expect(request.snapshot.input.workProductId).toBe(applied.revisions[0]!.workProductId);
    expect(request.snapshot.input.producer).toEqual(s.producer);
    expect((await preserved(c)).pins).toEqual(before.pins);
  }, 30000);
  it("preserves ordinary A preparation through an existing nested transaction", async () => {
    const s = await makeCommitSource(owned.db, owned.root, "html"), c = { s, peer: owned.connect() };
    const input = await ready(c), before = await preserved(c);
    const result = await s.db.transaction(tx => prepare({ ...input, db: tx as unknown as typeof s.db }));
    expect(result.snapshot.qaCorrectionFollowup).toBeUndefined();
    expect(result.snapshot.input.workProductId).toBe(s.productId);
    expect(result.snapshot.input.producer).toEqual(s.producer);
    expect(await readFile(String(result.parameters.html))).toEqual(commitBuffers("html", "old").get("report.html"));
    expect((await preserved(c)).pins).toEqual(before.pins);
    expect((await step(c)).metadata.toolArtifactRequest).toEqual(result.snapshot);
  }, 20000);
  it("refuses nested B preparation without pretending its transaction is a root connection", async () => {
    const c = await issueC02(owned), input = await ready(c), before = await preserved(c);
    await c.s.db.transaction(async tx => {
      await expect(prepare({ ...input, db: tx as unknown as typeof c.s.db }))
        .rejects.toThrow("qa_correction_followup_transaction");
    });
    expect(await preserved(c)).toEqual(before);
  }, 20000);
  it("includes the exact followup ref in same-request conflict identity", async () => {
    const c = await issueC02(owned), input = await ready(c), result = await prepare(input), current = await step(c);
    const changed = { ...result.snapshot, qaCorrectionFollowup: { ...c.ref, requestId: randomUUID() } };
    await c.peer.update(workflowStepRuns).set({ metadata: { ...current.metadata, toolArtifactRequest: changed } })
      .where(eq(workflowStepRuns.id, current.id));
    const before = await preserved(c);
    await expect(prepare(input)).rejects.toThrow("qa_artifact_request_conflict");
    expect(await preserved(c)).toEqual(before);
  }, 20000);
  it("does not reinterpret a direct writer call with A's pin as ordinary input", async () => {
    const c = await issueC02(owned), input = await ready(c);
    await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId }).where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
    const before = await preserved(c);
    await expect(prepare({ ...input, parameters: { html: c.s.file, manifest: path.join(c.s.directory, "bundle-index.json") } })).rejects.toThrow();
    expect(await preserved(c)).toEqual(before);
  }, 20000);
  it.each(["report.html", "bundle-index.json", "assets/nested/pixel.svg", "source-notes.txt"])(
    "refuses damaged issued %s without replacing A's request or pin", async name => {
      const c = await issueC02(owned), input = await ready(c), before = await preserved(c);
      const file = path.join(c.applied.revisions[0]!.root, name), original = await readFile(file);
      try {
        await chmod(file, 0o600);
        await writeFile(file, "damaged");
        await expect(prepare(input)).rejects.toThrow("qa_correction_followup_bytes");
        expect(await preserved(c)).toEqual(before);
      } finally { await writeFile(file, original); await chmod(file, 0o444); }
    }, 20000);
  it.each(["missing-asset", "extra-asset", "role-name", "asset-hash", "asset-size"] as const)(
    "rejects captured %s even after a valid full observation", async fault => {
      const c = await issueC02(owned), input = await ready(c), before = await preserved(c), actual = bundles.readHtmlBundle;
      vi.spyOn(bundles, "readHtmlBundle").mockImplementationOnce(async (...args) => {
        const bundle = await actual(...args);
        if (fault === "missing-asset") bundle.assets = [];
        if (fault === "extra-asset") bundle.assets.push({ ...bundle.assets[0]!, fileName: "extra.svg" });
        if (fault === "role-name") bundle.ancillary[0]!.fileName = "source-notes.txt";
        if (fault === "asset-hash") bundle.assets[0]!.sha256 = "00".repeat(32);
        if (fault === "asset-size") bundle.assets[0]!.byteSize++;
        return bundle;
      });
      await expect(prepare(input)).rejects.toThrow("workproduct_selector_correction_request_");
      expect(await preserved(c)).toEqual(before);
    }, 20000);
  it.each(["binding", "cancel"] as const)("rejects %s committed by another connection after observation", async fault => {
    const c = await issueC02(owned), input = await ready(c), actual = followups.observeQaCorrectionFollowup;
    let after: Awaited<ReturnType<typeof preserved>> | undefined;
    vi.spyOn(followups, "observeQaCorrectionFollowup").mockImplementationOnce(async (...args) => {
      const token = await actual(...args);
      expect(token.ref).toEqual(c.ref);
      if (fault === "binding") await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId })
        .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
      else await c.peer.update(issues).set({ status: "cancelled" }).where(eq(issues.id, c.s.f.qa.issueId!));
      after = await preserved(c);
      return token;
    });
    await expect(prepare(input)).rejects.toThrow();
    expect(after).toBeDefined();
    expect(await preserved(c)).toEqual(after);
    if (fault === "binding") await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.applied.revisions[0]!.workProductId })
      .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
    else await c.peer.update(issues).set({ status: "todo" }).where(eq(issues.id, c.s.f.qa.issueId!));
    expect((await prepare(input)).snapshot.input.workProductId).toBe(c.applied.revisions[0]!.workProductId);
  }, 30000);
  it("rejects B after C wins, then prepares only C with the original producer", async () => {
    const b = await issueC02(owned), oldInput = await ready(b);
    // Restore the fixture's failed request before asking the real issuer for the next correction.
    await b.peer.update(workflowStepRuns).set({ status: "failed", lastDispatchRequestId: b.s.request.requestId,
      metadata: { artifactExecution: b.s.request.artifactExecution, toolArtifactRequest: b.s.request } })
      .where(eq(workflowStepRuns.id, b.s.f.qa.id));
    const c = await issueNextC02(b), input = await ready(c), before = await preserved(c);
    await expect(prepare({ ...input, parameters: oldInput.parameters })).rejects.toThrow("qa_artifact_input_mismatch");
    expect(await preserved(c)).toEqual(before);
    const result = await prepare(input), main = commitBuffers("html", "final").get("report.html")!;
    expect(result.snapshot.input.workProductId).toBe(c.applied.revisions[0]!.workProductId);
    expect(result.snapshot.input.producer).toEqual(b.s.producer);
    expect(result.snapshot.qaCorrectionFollowup).toEqual(c.ref);
    expect(await readFile(String(result.parameters.html))).toEqual(main);
  }, 30000);
});
