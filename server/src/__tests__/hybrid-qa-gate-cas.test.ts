import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping gate CAS tests: ${support.reason ?? "unsupported"}`);
}

describeEP("hybrid QA — gate CAS idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-cas-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CAS Co", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("first sync resets stale gate; second sync does NOT reset again (generation marker match)", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `p-${randomUUID().slice(0, 8)}`;
    const gateStepId = `g-${randomUUID().slice(0, 8)}`;
    const oldReq = `req-old-${randomUUID()}`;

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "CAS WF",
      stepsJson: [
        { id: producerStepId, name: "Produce", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
        { id: gateStepId, name: "Gate", agentId: "", type: "tool", qaType: "structural",
          toolNames: ["v"], dependencies: [producerStepId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    // Producer completed with iteration=1 (was reworked)
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: producerStepId, status: "completed",
      issueId: null, iterationIndex: 1, completedAt: new Date(Date.now() - 60_000),
    });

    // Gate completed with old generation marker — stale
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(Date.now() - 120_000),
      lastDispatchRequestId: oldReq,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();

    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${oldReq}`,
      payload: { kind: "structural_gate_verdict", verdict: "pass" },
      createdAt: new Date(Date.now() - 120_000),
    });

    // First sync: should reset stale gate (generation marker 0 < producer iteration 1)
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    // Verify gate was reset (no longer completed with stale PASS)
    const [after1st] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(after1st.status).not.toBe("completed");
    // Generation marker should now be 1 (matching producer)
    const meta1 = after1st.metadata as Record<string, unknown>;
    expect(meta1?.structuralGateProducerGeneration).toBe(1);

    // Simulate gate completing again with a NEW requestId (new generation)
    const newReq = `req-new-${randomUUID()}`;
    await db.update(workflowStepRuns).set({
      status: "completed", completedAt: new Date(),
      lastDispatchRequestId: newReq,
    }).where(eq(workflowStepRuns.id, gateRun[0].id));

    // Second sync: should NOT reset again — generation marker matches producer iteration
    await syncWorkflowRunState(db, runId);
    setWorkflowToolStepExecutor(null);

    const [after2nd] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    // Gate should remain completed — generation marker matches, no repeated reset
    expect(after2nd.status).toBe("completed");
    expect(after2nd.lastDispatchRequestId).toBe(newReq);
  });
});
