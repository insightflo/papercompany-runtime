import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issueWorkProducts, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { rmSync } from "node:fs";
import { ensureToolRecoveryCard } from "../services/missions/tool-recovery-card.js";
import { missions } from "@paperclipai/db";
import { workProductProducerMismatches } from "../services/workflow/workproduct-producer-comparison.js";

it("a currently matching producer becomes stale under the prospective all-step generation bump", () => {
  const p = { schemaVersion: "workflow.work-product-producer.v1" as const, companyId: "company", missionId: "mission",
    workflowRunId: "run", stepRunId: "step", stepId: "producer", executionGeneration: 3, retryCount: 2, iterationIndex: 1, heartbeatRunId: "heartbeat" };
  const scope = { companyId: "company", workflowRunId: "run", run: { missionId: "mission" },
    step: { id: "step", stepId: "producer", executionGeneration: 3, retryCount: 2, iterationIndex: 1 },
    product: { sourceExecutionGeneration: 3, createdByRunId: "heartbeat" } };
  expect(workProductProducerMismatches(p, scope)).toEqual([]);
  expect(workProductProducerMismatches(p, { ...scope, step: { ...scope.step, executionGeneration: 4 } }))
    .toEqual(["executionGeneration", "sourceExecutionGeneration"]);
});

// Catches a falsely fresh producer after same-run generation/attempt changes.
describeQualityDb("read-only same-run producer observations", () => {
  let fixture: Awaited<ReturnType<typeof createQualityTestDb>>;
  const roots: string[] = [];
  beforeAll(async () => { fixture = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await fixture?.close(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
  it("reports current and prospective stale fields without modifying producer provenance", async () => {
    const db = fixture.db;
    const s = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(s.tempRoot);
    const [card] = await db.select().from(issues).where(eq(issues.id, s.recoveryIssueId));
    const [mission] = await db.select().from(missions).where(eq(missions.id, card.missionId!));
    const [oversightIssue] = await db.select().from(issues).where(eq(issues.id, card.originId!));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "producer", issueId: card.id,
      status: "completed", executionGeneration: 3, retryCount: 2, iterationIndex: 1 }).returning();
    const heartbeatRunId = randomUUID();
    const [product] = await db.insert(issueWorkProducts).values({ companyId: s.companyId, issueId: card.id,
      type: "document", status: "active", title: "input.json", provider: "local", externalId: "/tmp/input.json", sourceExecutionGeneration: 2,
      metadata: { workflowProducer: { schemaVersion: "workflow.work-product-producer.v1", companyId: s.companyId,
        missionId: mission.id, workflowRunId: run.id, stepRunId: producer.id, stepId: "producer",
        executionGeneration: 2, retryCount: 0, iterationIndex: 0, heartbeatRunId } } }).returning();
    const step = { id: stepRun.stepId, name: "tool", type: "tool" as const, agentId: "", dependencies: ["producer"], toolNames: ["collect-us-stockflow"],
      toolArgs: { input: "{$steps.producer.workProductPath}" }, workProductSelectors: { producer: { type: "document", title: "input.json" } } };
    const result = await ensureToolRecoveryCard(db, {}, { mission, oversightIssue, run, stepRun, workflowName: "test", step }, 
    async (tx, companyId, data) => (await tx.insert(issues).values({ ...data, companyId }).returning())[0]);
    expect(result.issue.description).toContain("workproduct_selector_stale_producer");
    expect(result.issue.description).toContain("retryCount");
    expect(result.issue.description).toContain("iterationIndex");
    expect(result.issue.description).toContain("prospective");
    expect(result.issue.description).toContain(product.id);
    expect((await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product.id)))[0]).toEqual(product);
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producer.id)))[0]).toEqual(producer);
  });
});
