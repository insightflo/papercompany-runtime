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
import { applyStructuralGatePass } from "../services/workflow/control-flow/structural-gate-rework.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip exact-verdict tests: ${support.reason ?? "unsupported"}`);

describeEP("hybrid QA — exact-current verdict ordering", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-exact-v-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ExactV", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("stale reqA verdict (newer timestamp) does not affect current reqB gate behavior", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const reqA = `reqA-${randomUUID()}`;
    const reqB = `reqB-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "ExactV WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    // Producer completed
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(Date.now() - 120_000),
    });

    // Gate failed, currently carrying requestId B
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, lastDispatchRequestId: reqB,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();

    // Stale reqA verdict: request_changes, NEWER timestamp (would fool latest-verdict ordering)
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${reqA}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes", requestId: reqA, reason: "stale reqA reason" },
      createdAt: new Date(), // NEWER than producer completion
    });

    // Call pass — must query ONLY exact current reqB, find no reqB verdict → no rework
    const freshRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: freshRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Producer must NOT be reset — stale reqA verdict must not trigger rework on reqB gate
    const [prod] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, prodId));
    expect(prod.status).toBe("completed");
    expect(prod.iterationIndex).toBe(0);
  });

  it("current reqB request_changes triggers rework even when stale reqA pass exists", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p2-${randomUUID().slice(0, 8)}`;
    const gateId = `g2-${randomUUID().slice(0, 8)}`;
    const reqA = `reqA2-${randomUUID()}`;
    const reqB = `reqB2-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "ExactV WF2", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    const oldCompletedAt = new Date(Date.now() - 120_000);
    const prodRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: oldCompletedAt,
      lastDispatchRequestId: `p-${randomUUID()}`,
    }).returning();

    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, lastDispatchRequestId: reqB,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();

    // Old reqA verdict: PASS (earlier timestamp)
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${reqA}`,
      payload: { kind: "structural_gate_verdict", verdict: "pass", requestId: reqA },
      createdAt: new Date(Date.now() - 90_000),
    });

    // Current reqB verdict: request_changes (after producer completion)
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${reqB}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes", requestId: reqB, reason: "current reqB failure" },
      createdAt: new Date(Date.now() - 30_000),
    });

    const freshRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: freshRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Producer MUST be reset — reqB request_changes is current and fresh
    const [prod] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, prodRun[0].id));
    expect(prod.status).toBe("pending");
    expect(prod.iterationIndex).toBe(1);
  });
});
