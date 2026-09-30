import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueWorkProducts, issues, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowStepOutputBindings, agents } from "@paperclipai/db";
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
