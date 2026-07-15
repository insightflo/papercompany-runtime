import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping crash recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEP("hybrid QA — crash recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-crash-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Crash Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId,
      title: "Crash Mission", status: "active",
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  it("resets stale terminal gate when producer has recompleted after rework", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `action-1-${randomUUID().slice(0, 8)}`;
    const gateStepId = `qa-1-${randomUUID().slice(0, 8)}`;
    const semanticQaStepId = `qa-2-${randomUUID().slice(0, 8)}`;

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Crash WF",
      stepsJson: [
        { id: producerStepId, name: "[ACTION] Produce", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
        { id: gateStepId, name: "[QA] Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: [producerStepId], graphWorkProductRequired: false },
        { id: semanticQaStepId, name: "[QA] Semantic", agentId: "a1", dependencies: [producerStepId, gateStepId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    // Producer: completed with iterationIndex=1 (reworked and regenerated)
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: producerStepId, status: "completed",
      issueId: null, iterationIndex: 1, completedAt: new Date(Date.now() - 60_000),
    });

    // Gate: completed with stale PASS from before producer recompleted
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId, status: "completed",
      issueId: null, completedAt: new Date(Date.now() - 120_000),
    }).returning();

    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:old-req`,
      payload: { kind: "structural_gate_verdict", verdict: "pass" },
      createdAt: new Date(Date.now() - 120_000),
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    setWorkflowToolStepExecutor(null);

    const [updatedGate] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(updatedGate.status).not.toBe("completed");
    expect(updatedGate.completedAt).toBeNull();
  });

  it("does NOT reset gate when producer has not been reworked (iterationIndex=0)", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `action-2-${randomUUID().slice(0, 8)}`;
    const gateStepId = `qa-3-${randomUUID().slice(0, 8)}`;

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "No Crash WF",
      stepsJson: [
        { id: producerStepId, name: "[ACTION] Produce", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
        { id: gateStepId, name: "[QA] Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: [producerStepId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: producerStepId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(Date.now() - 30_000),
    });

    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId, status: "completed",
      issueId: null, completedAt: new Date(Date.now() - 20_000),
    }).returning();

    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:req-1`,
      payload: { kind: "structural_gate_verdict", verdict: "pass" },
      createdAt: new Date(Date.now() - 20_000),
    });

    await syncWorkflowRunState(db, runId);

    const [updatedGate] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(updatedGate.status).toBe("completed");
  });
});
