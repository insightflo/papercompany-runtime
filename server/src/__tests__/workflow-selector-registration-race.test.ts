import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, missions, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowStepOutputBindings, issueWorkProducts } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import * as selectors from "../services/workflow/workproduct-selector.js";
import * as producers from "../services/work-products/producer-provenance.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("selector-registration-race-");
  db = createDb(temp.connectionString); dir = await mkdtemp(path.join(os.tmpdir(), "selector-race-files-"));
}, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function fixture(withMission = true) {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = withMission ? randomUUID() : null, workflowId = randomUUID();
  const runId = randomUUID(), producerId = randomUUID(), consumerId = randomUUID(), issueId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Selector race", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  if (missionId) await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Race", status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Race", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, status: "running", triggeredBy: "board" });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Write" });
  await db.insert(workflowStepRuns).values([
    { id: producerId, workflowRunId: runId, stepId: "write", issueId, status: "completed", executionGeneration: 3 },
    { id: consumerId, workflowRunId: runId, stepId: "qa", status: "pending" },
  ]);
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerId, heartbeatId });
  const register = async (label: string) => {
    const folder = path.join(dir, companyId, label); await mkdir(folder, { recursive: true });
    const file = path.join(folder, "content.json"); await writeFile(file, "{}");
    const product = await workProductService(db).createForIssue(issueId, companyId, {
      provider: "local_file", type: "document", title: "content.json", status: "active", isPrimary: false,
      createdByRunId: heartbeatId, metadata: { path: file },
    });
    expect(product?.metadata?.workflowProducer).toMatchObject({ stepRunId: producerId, executionGeneration: 3 });
    return product!;
  };
  const steps = [{ id: "write" }, { id: "qa", dependencies: ["write"],
    toolArgs: { content: "{$steps.write.workProductPath}" },
    workProductSelectors: { write: { type: "document" as const, title: "content.json" } } }];
  const resolve = (args?: unknown) => resolveWorkflowToolStepArgs({ db, run: { id: runId, companyId },
    step: { ...steps[1], ...(args ? { toolArgs: args } : {}) }, workflowSteps: steps, consumerStepRunId: consumerId });
  const pins = () => db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, consumerId));
  const addSecond = async () => {
    const secondIssue = randomUUID(), secondProducer = randomUUID(), secondHeartbeat = randomUUID(), secondConsumer = randomUUID();
    await db.insert(issues).values({ id: secondIssue, companyId, missionId, title: "Write second" });
    await db.insert(workflowStepRuns).values([
      { id: secondProducer, workflowRunId: runId, stepId: "second", issueId: secondIssue, status: "completed", executionGeneration: 3 },
      { id: secondConsumer, workflowRunId: runId, stepId: "qa2", status: "pending" },
    ]);
    await admittedProducer(db, { companyId, agentId, issueId: secondIssue, stepRunId: secondProducer, heartbeatId: secondHeartbeat });
    const file = path.join(dir, `${secondIssue}.json`); await writeFile(file, "{}");
    await workProductService(db).createForIssue(secondIssue, companyId, { provider: "local_file", type: "document",
      title: "second.json", status: "active", isPrimary: false, createdByRunId: secondHeartbeat, metadata: { path: file } });
    const resolveBoth = (reverse = false, fail = false) => {
      const selected = { type: "document" as const, title: "content.json" };
      const second = { type: "document" as const, title: "second.json" };
      const step = { id: reverse ? "qa2" : "qa", dependencies: ["write", "second"],
        workProductSelectors: reverse ? { second, write: selected } : { write: selected, second },
        toolArgs: { a: "{$steps.write.workProductPath}", b: "{$steps.second.workProductPath}", ...(fail ? { bad: "{$childInputs.missing}" } : {}) } };
      return resolveWorkflowToolStepArgs({ db, run: { id: runId, companyId }, step,
        workflowSteps: [{ id: "write" }, { id: "second" }, step], consumerStepRunId: reverse ? secondConsumer : consumerId });
    };
    return { resolveBoth, file };
  };
  return { companyId, runId, issueId, register, resolve, pins, addSecond };
}
async function waitForBlockedOrDone(done: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (done()) return "committed";
    const rows = await db.execute(sql`select pid, query from pg_stat_activity where datname = current_database()
      and pid <> pg_backend_pid() and cardinality(pg_blocking_pids(pid)) > 0`);
    if (rows.length) { console.log("PostgreSQL lock wait", rows); return "blocked"; }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("neither official registration completion nor actual PostgreSQL lock wait observed");
}

// Break caught: separate selection and first-pin transactions let official B commit between them.
it.each([true, false])("serializes official same-title registration until FIRST pin commits (mission=%s), allowing later registration", async withMission => {
  const f = await fixture(withMission), a = await f.register("A"), selected = gate(), resume = gate();
  const actual = selectors.resolveSelectedPaths;
  vi.spyOn(selectors, "resolveSelectedPaths").mockImplementationOnce(async (...args) => {
    const result = await actual(...args); selected.release(); await resume.promise; return result;
  });
  const resolving = f.resolve(); await selected.promise;
  let committed = false;
  const registering = f.register("B").then(p => { committed = true; return p; });
  let state: string;
  try { state = await waitForBlockedOrDone(() => committed); }
  finally { resume.release(); }
  const [args, b] = await Promise.all([resolving, registering]);
  const pins = await f.pins();
  const products = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.issueId, f.issueId), eq(issueWorkProducts.title, "content.json")));
  console.log("P1 exact interleave", { state: state!, productCount: products.length, pinnedA: pins[0]?.workProductId === a.id, b: b.id });
  expect(products).toHaveLength(2);
  expect(args).toEqual({ content: a.metadata!.path });
  expect(pins).toHaveLength(1); expect(pins[0].workProductId).toBe(a.id);
  expect(await f.resolve()).toEqual(args); // Later B must not replace or invalidate an existing pin.
  const qaSelection = await selectors.selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: f.runId,
    stepId: "write", selector: { type: "document", title: "content.json" }, pinnedId: pins[0].workProductId });
  expect(qaSelection.product.id).toBe(a.id); // The actual pinned-ID reader used by QA.
  expect(state!).toBe("blocked");
}, 15000);

// Break caught: selector does not wait for an official producer holding its pre-insert guard.
it("registration winner commits B before selection, which refuses ambiguity and writes no pin", async () => {
  const f = await fixture(); await f.register("A");
  const registered = gate(), resume = gate(), actual = producers.registeredProducer;
  vi.spyOn(producers, "registeredProducer").mockImplementationOnce(async (...args) => {
    const result = await actual(...args); registered.release(); await resume.promise; return result;
  });
  const registering = f.register("B"); await registered.promise;
  let done = false;
  const resolving = f.resolve().then(value => ({ value }), error => ({ error })).finally(() => { done = true; });
  let state: string;
  try { state = await waitForBlockedOrDone(() => done); } finally { resume.release(); }
  await registering; const result = await resolving;
  expect(state!).toBe("blocked");
  expect(result).toHaveProperty("error.message", "workproduct_selector_not_exactly_one");
  expect(await f.pins()).toEqual([]);
}, 15000);

// Break caught: a resolver failure after pin insertion commits part of a frozen input.
it("rolls all first pins back if complete multi-selector argument resolution fails", async () => {
  const f = await fixture(); await f.register("A"); const second = await f.addSecond();
  await expect(second.resolveBoth(false, true)).rejects.toThrow("Unresolved");
  expect(await f.pins()).toEqual([]);
});

it("concurrent consumers with reversed selector order each atomically pin the same two official sources", async () => {
  const f = await fixture(), a = await f.register("A"), second = await f.addSecond();
  const selected = gate(), resume = gate(), actual = selectors.resolveSelectedPaths;
  vi.spyOn(selectors, "resolveSelectedPaths").mockImplementationOnce(async (...args) => {
    const result = await actual(...args); selected.release(); await resume.promise; return result;
  });
  const first = second.resolveBoth(); await selected.promise;
  let done = false;
  const other = second.resolveBoth(true).finally(() => { done = true; });
  let state: string;
  try { state = await waitForBlockedOrDone(() => done); } finally { resume.release(); }
  const results = await Promise.all([first, other]);
  expect(state!).toBe("blocked");
  expect(results).toEqual([{ a: a.metadata!.path, b: second.file }, { a: a.metadata!.path, b: second.file }]);
  const pins = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.workflowRunId, f.runId));
  expect(pins).toHaveLength(4); expect(new Set(pins.map(p => p.workProductId)).size).toBe(2);
}, 15000);
