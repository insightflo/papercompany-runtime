import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, instanceSettings, issueWorkProducts, issues, workflowDefinitions,
  workflowRunSeeds, workflowRuns, workflowStepRuns, workflowStepOutputBindings, agents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

// Selecting the newest primary instead of the exact registered current producer must fail these tests.
describe("typed official work product selector", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("selector-v31-"); db = createDb(temp.connectionString); }, 60000);
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), runId = randomUUID(), workflowId = randomUUID(), issueId = randomUUID();
    const producerId = randomUUID(), consumerId = randomUUID(), agentId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Selector", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Selector", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "board" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
    await db.insert(workflowStepRuns).values([
      { id: producerId, workflowRunId: runId, stepId: "write", issueId, status: "completed", executionGeneration: 3 },
      { id: consumerId, workflowRunId: runId, stepId: "qa", status: "pending" },
    ]);
    await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerId, heartbeatId });
    const provenance = { schemaVersion: "workflow.work-product-producer.v1", companyId, missionId: null,
      workflowRunId: runId, stepRunId: producerId, stepId: "write", executionGeneration: 3, retryCount: 0, iterationIndex: 0, heartbeatRunId: heartbeatId };
    const product = async (type: string, title: string, extra: Record<string, unknown> = {}) => {
      const [p] = await db.insert(issueWorkProducts).values({ companyId, issueId, type, title, provider: "local_file",
        status: "active", isPrimary: true, createdByRunId: heartbeatId, sourceExecutionGeneration: 3,
        metadata: { path: `/tmp/${title}`, workflowProducer: provenance }, ...extra }).returning(); return p;
    };
    const steps = [{ id: "write" }, { id: "qa", dependencies: ["write"], toolArgs: { content: "{$steps.write.workProductPath}" },
      workProductSelectors: { write: { type: "document" as const, title: "content.json" } } }];
    const resolve = () => resolveWorkflowToolStepArgs({ db, run: { id: runId, companyId }, step: steps[1], workflowSteps: steps, consumerStepRunId: consumerId });
    return { product, resolve, provenance, consumerId };
  }
  it("selects document despite a newer primary PNG", async () => {
    const f = await fixture(); await f.product("document", "content.json"); await f.product("artifact", "cover.png");
    expect(await f.resolve()).toEqual({ content: "/tmp/content.json" });
  });
  it.each(["missing", "duplicate", "old-generation", "old-attempt"])("rejects %s before pin writes", async reason => {
    const f = await fixture();
    if (reason !== "missing") await f.product("document", "content.json", reason === "old-generation"
      ? { sourceExecutionGeneration: 2 } : reason === "old-attempt"
      ? { metadata: { path: "/tmp/content.json", workflowProducer: { ...f.provenance, retryCount: 9 } } } : {});
    if (reason === "duplicate") await f.product("document", "content.json", { isPrimary: false });
    await expect(f.resolve()).rejects.toThrow(/workproduct_selector/);
    expect((await db.select().from(workflowStepOutputBindings)).filter(p => p.consumerStepRunId === f.consumerId)).toEqual([]);
  });
});

// [소비 하드닝 4단계 — TEST-FIRST RED→GREEN] selector 없는 타-단계 참조의 레거시 폴백 소비:
// 플래그 OFF 에서는 새 폴백 핀 1건마다 감사(activity_log)를 남기고, 플래그 ON 에서는
// 새 폴백 해석·기존 핀 소비 모두 workproduct_selector_required 로 명시 거부한다(핀 생성 이전).
// selector 있음/시드 있음 경로는 플래그와 무관하게 영향받지 않는다.
describe("selector-less fallback pin audit + flag-gated rejection", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("selector-stage4-"); db = createDb(temp.connectionString); }, 60000);
  afterEach(async () => { await db.delete(instanceSettings); });
  afterAll(async () => { await temp?.cleanup(); });

  async function setFlags(experimental: Record<string, unknown>) {
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental } });
  }

  async function world() {
    const companyId = randomUUID(), runId = randomUUID(), workflowId = randomUUID(), issueId = randomUUID();
    const producerRunId = randomUUID(), consumerRunId = randomUUID(), agentId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stage4", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Stage4", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "board" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
    await db.insert(workflowStepRuns).values([
      { id: producerRunId, workflowRunId: runId, stepId: "write", issueId, status: "completed", executionGeneration: 3 },
      { id: consumerRunId, workflowRunId: runId, stepId: "qa", status: "pending" },
    ]);
    await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerRunId, heartbeatId });
    const provenance = { schemaVersion: "workflow.work-product-producer.v1", companyId, missionId: null,
      workflowRunId: runId, stepRunId: producerRunId, stepId: "write", executionGeneration: 3, retryCount: 0, iterationIndex: 0, heartbeatRunId: heartbeatId };
    const product = async (type = "document", title = "content.json") => {
      const [p] = await db.insert(issueWorkProducts).values({ companyId, issueId, type, title, provider: "local_file",
        status: "active", isPrimary: true, createdByRunId: heartbeatId, sourceExecutionGeneration: 3,
        metadata: { path: `/tmp/${title}`, workflowProducer: provenance } }).returning();
      return p!;
    };
    const steps = (selectors?: Record<string, unknown>) => {
      const qa: Record<string, unknown> = { id: "qa", dependencies: ["write"], toolArgs: { content: "{$steps.write.workProductPath}" } };
      if (selectors) qa.workProductSelectors = selectors;
      return [{ id: "write" }, qa] as [{ id: string }, typeof qa & { workProductSelectors?: unknown }];
    };
    const resolve = (stepList = steps()) => resolveWorkflowToolStepArgs({
      db, run: { id: runId, companyId }, step: stepList[1], workflowSteps: stepList, consumerStepRunId: consumerRunId });
    return { companyId, runId, consumerRunId, producerRunId, product, steps, resolve };
  }

  const fallbackAudits = (companyId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "workflow.workproduct_fallback_pin")));
  const consumerPins = (consumerStepRunId: string) =>
    db.select().from(workflowStepOutputBindings).then(rows => rows.filter(p => p.consumerStepRunId === consumerStepRunId));

  it("flag off: a new fallback pin writes exactly one audit row", async () => {
    await setFlags({ enableWorkProductBindingV1: true });
    const f = await world(); const p = await f.product();
    expect(await f.resolve()).toEqual({ content: "/tmp/content.json" });
    const pins = await consumerPins(f.consumerRunId);
    expect(pins).toHaveLength(1);
    const audits = await fallbackAudits(f.companyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ companyId: f.companyId, actorType: "system", actorId: "workproduct-fallback-observer",
      action: "workflow.workproduct_fallback_pin", entityType: "workflow_step_run", entityId: f.consumerRunId,
      details: { schemaVersion: "workflow.workproduct-fallback-pin.v1", workflowRunId: f.runId,
        consumerStepRunId: f.consumerRunId, referencedStepId: "write", workProductId: p.id,
        type: "document", title: "content.json" } });
  });

  it("flag off: re-resolution of an already-pinned reference writes no further audit", async () => {
    await setFlags({ enableWorkProductBindingV1: true });
    const f = await world(); await f.product();
    const first = await f.resolve();
    const second = await f.resolve();
    expect(second).toEqual(first);
    expect(await consumerPins(f.consumerRunId)).toHaveLength(1);
    expect(await fallbackAudits(f.companyId)).toHaveLength(1);
  });

  it("flag on: rejects a new fallback interpretation before any pin with a copy-paste selector snippet", async () => {
    await setFlags({ enableWorkProductBindingV1: true, enableWorkProductSelectorRejectV1: true });
    const f = await world(); await f.product();
    await expect(f.resolve()).rejects.toThrow(/workproduct_selector_required/);
    await expect(f.resolve()).rejects.toThrow('{"write":{"type":"document","title":"content.json"}}');
    expect(await consumerPins(f.consumerRunId)).toEqual([]);
    expect(await fallbackAudits(f.companyId)).toHaveLength(0);
  });

  it("flag on: rejects consuming an existing selector-less pin, snippet naming the pinned product", async () => {
    await setFlags({ enableWorkProductBindingV1: true });
    const f = await world(); await f.product();
    await f.resolve(); // legacy pin + audit created while the flag was off
    await setFlags({ enableWorkProductBindingV1: true, enableWorkProductSelectorRejectV1: true });
    await expect(f.resolve()).rejects.toThrow(/workproduct_selector_required/);
    await expect(f.resolve()).rejects.toThrow('{"write":{"type":"document","title":"content.json"}}');
    expect(await consumerPins(f.consumerRunId)).toHaveLength(1); // the pre-existing pin, unchanged
  });

  it("flag on: selector-present resolution is untouched", async () => {
    await setFlags({ enableWorkProductBindingV1: true, enableWorkProductSelectorRejectV1: true });
    const f = await world(); await f.product("document", "content.json");
    await expect(f.resolve(f.steps({ write: { type: "document", title: "content.json" } })))
      .resolves.toEqual({ content: "/tmp/content.json" });
  });

  it("flag on: a tool-output-seeded reference is not a rejection target", async () => {
    await setFlags({ enableWorkProductSelectorRejectV1: true }); // binding off: legacy product path resolves
    const f = await world(); const p = await f.product();
    const hex = "a".repeat(64);
    await db.insert(workflowRunSeeds).values({ companyId: f.companyId, targetRunId: f.runId, targetStepId: "write",
      targetStepRunId: randomUUID(), sourceRunId: f.runId, sourceStepId: "write", sourceStepRunId: f.producerRunId,
      approvedByUserId: "local-board",
      evidence: { schemaVersion: "workflow.seed.tool-output.v1", sourceDefinitionHash: hex, targetDefinitionHash: hex,
        stepConfigHash: hex, stepConfigHashVersion: 2,
        artifact: { stepRunId: randomUUID(), requestId: "seeded", path: `/tmp/${p.title}`, sha256: hex,
          byteSize: 2, executionGeneration: 0, retryCount: 0, iterationIndex: 0 } } });
    await expect(f.resolve()).resolves.toEqual({ content: "/tmp/content.json" });
  });

  it("absent or malformed flag values behave as off", async () => {
    const f = await world(); await f.product(); // no instance_settings row at all
    await expect(f.resolve()).resolves.toEqual({ content: "/tmp/content.json" });
    await setFlags({ enableWorkProductBindingV1: true, enableWorkProductSelectorRejectV1: "yes" }); // malformed value
    const g = await world(); await g.product();
    await expect(g.resolve()).resolves.toEqual({ content: "/tmp/content.json" });
    expect(await consumerPins(g.consumerRunId)).toHaveLength(1);
  });

  it("company allowlist enables rejection for listed companies only", async () => {
    const f = await world();
    await setFlags({ enableWorkProductBindingV1: true, enableWorkProductSelectorRejectCompanyIdsV1: [f.companyId] });
    await f.product();
    await expect(f.resolve()).rejects.toThrow(/workproduct_selector_required/);
    const g = await world(); // not allowlisted
    await g.product();
    await expect(g.resolve()).resolves.toEqual({ content: "/tmp/content.json" });
  });
});
