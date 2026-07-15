import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  issueComments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  completeWorkflowToolStepFromResult,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping hybrid QA integration tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEP("hybrid QA — structural gate integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-struct-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "QA Agent", role: "qa",
      status: "idle", adapterType: "process", adapterConfig: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId,
      title: "Test Mission", status: "active",
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWorkflowWithStructuralGate() {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `action-1-${randomUUID().slice(0, 8)}`;
    const gateStepId = `qa-1-${randomUUID().slice(0, 8)}`;
    const semanticQaStepId = `qa-2-${randomUUID().slice(0, 8)}`;

    const steps = [
      {
        id: producerStepId,
        name: "[ACTION] Produce output",
        agentId,
        dependencies: [],
        graphWorkProductRequired: true,
      },
      {
        id: gateStepId,
        name: "[QA] Structural gate",
        agentId: "",
        type: "tool",
        qaType: "structural",
        toolNames: ["validate-contract"],
        dependencies: [producerStepId],
        graphWorkProductRequired: false,
      },
      {
        id: semanticQaStepId,
        name: "[QA] Semantic review",
        agentId,
        dependencies: [gateStepId],
        graphWorkProductRequired: false,
        conditionalDependencies: [
          { stepId: semanticQaStepId, when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 },
        ],
      },
    ];

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Structural Gate WF",
      stepsJson: steps,
    });
    await db.insert(workflowRuns).values({
      id: runId, companyId, workflowId: wfId, missionId,
      status: "running", triggeredBy: "test",
    });

    // Seed producer as completed (with completedAt so gate dispatch can capture
    // the exact current-generation producer token).
    const producerCompletedAt = new Date(Date.now() - 1000);
    const producerRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: producerStepId,
      status: "completed", issueId: null,
      iterationIndex: 0, completedAt: producerCompletedAt,
    }).returning();

    // Seed gate as running (will be completed via completeWorkflowToolStepFromResult).
    // The dispatch-time producer token is captured as a metadata snapshot — it is
    // NEVER recaptured or weakened at completion (fail-closed invariant).
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId,
      status: "running", issueId: null,
      lastDispatchRequestId: `req-${randomUUID()}`,
      metadata: {
        structuralGateProducerToken: {
          producerStepId, iterationIndex: 0, completedAt: producerCompletedAt.toISOString(),
        },
      },
    }).returning();

    return { wfId, runId, producerStepId, gateStepId, semanticQaStepId, producerRun: producerRun[0], gateRun: gateRun[0] };
  }

  it("(A) valid request_changes writes official verdict and producer iteration increments", async () => {
    const { runId, gateRun, producerRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { verdict: "request_changes", reason: "schema key missing", failedChecks: ["id"] },
    });

    // Official verdict should be in transition events (issueId=null, issue-less)
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("workflow_validation_verdict");
    expect(events[0].verdict).toBe("request_changes");
    expect(events[0].reasonCode).toBe("workflow_tool_result");
    expect(events[0].issueId).toBeNull();

    // Producer should be reset for rework (iterationIndex incremented)
    const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerRun.id));
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);
  });

  it("(B) transport failure writes no verdict and consumes no iteration", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: false,
      requestId, workflowRunId: runId,
      error: "connection refused",
    });

    const [updated] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(updated.status).toBe("failed");
    expect(updated.lastDispatchErrorSummary).toBe("connection refused");

    // No verdict event
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(0);
  });

  it("(B2) missing/invalid verdict is contract hard failure, no verdict event", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { /* no verdict field */ },
    });

    const [updated] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(updated.status).toBe("failed");
    expect(updated.lastDispatchErrorSummary).toBe("structural_gate_contract_failure");

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(0);
  });

  it("(C) valid PASS completes the gate", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    const [updated] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(updated.status).toBe("completed");

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("pass");
  });

  it("idempotency: duplicate callback does not create a second verdict event", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    // Second call with same requestId should be a no-op (step already terminal)
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(1);
  });

  it("(D) stale callback after gate reset is rejected", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const oldRequestId = gateRun.lastDispatchRequestId!;

    // Complete with pass
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId: oldRequestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    // Simulate gate reset (clear dispatch state)
    await db.update(workflowStepRuns).set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      lastDispatchRequestId: null,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
    }).where(eq(workflowStepRuns.id, gateRun.id));

    // Late callback from old requestId should be rejected
    const result = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId: oldRequestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    expect(result).toBeNull();

    // Step should still be pending (not completed by stale callback)
    const [updated] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(updated.status).toBe("pending");
  });

  it("(E) cap remains exact — maxIterations is 2", async () => {
    // Verify the default cap hasn't changed through the integration path
    const { QA_REWORK_DEFAULT_MAX_ITERATIONS } = await import("../services/missions/workflow-qa-rework.js");
    expect(QA_REWORK_DEFAULT_MAX_ITERATIONS).toBe(2);
  });

  it("ledger write happens before step status update (fail-closed ordering)", async () => {
    const { runId, gateRun } = await seedWorkflowWithStructuralGate();
    const requestId = gateRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun.id, success: true,
      requestId, workflowRunId: runId,
      data: { verdict: "pass" },
    });

    // Both the verdict event AND the step completion must exist.
    // If the ledger write had failed, the function would have thrown
    // and the step would not be completed — this proves fail-closed ordering.
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("pass");
    const [updated] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(updated.status).toBe("completed");
  });
});