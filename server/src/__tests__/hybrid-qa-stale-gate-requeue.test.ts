import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

// Same wakeup-mock preamble as workflow-dag-engine.test.ts: the QA issue
// creation path enqueues assignment wakeups; the real enqueue path is not
// reliable inside this harness (FK cleanup failures), so bind it to a spy.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping stale gate requeue tests: ${support.reason ?? "unsupported host"}`);
}

// [GAZ 저녁3 4f8cfacb regression] Same-iteration producer double-completion:
//   1. producer completes at T1
//   2. structural gate dispatches, captures producer token (T1), returns PASS
//   3. producer RE-completes at T2 > T1 within the SAME iteration
//      (queued-wakeup revival → duplicate workflow/complete → completedAt re-stamp)
//   4. semantic QA step stays pending forever: evaluateSemanticStructuralReadiness
//      recomputes the expected token from the producer's CURRENT completedAt (T2)
//      and never matches the gate's captured T1 token — createWorkflowStepIssue
//      silently returns null every sync.
// Fix: sync must detect this exact stale-gate shape, reset the completed gate to
//   pending (CAS), record a structured finding, and let the launch loop
//   redispatch it with a fresh request id + fresh token so QA can launch.
describeEP("hybrid QA — stale structural gate requeue (same-iteration producer re-completion)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-stale-requeue-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stale Gate Requeue Co",
      issuePrefix: "SGR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Producer Agent", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
  });

  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  interface SeededChain {
    runId: string;
    producerStepId: string;
    gateStepId: string;
    qaStepId: string;
    gateRunId: string;
    gateRequestId: string;
    producerFirstCompletedAt: Date;
  }

  async function seedChain(): Promise<SeededChain> {
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId,
      title: "Stale gate mission", status: "active",
    });
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `action-produce-${randomUUID().slice(0, 8)}`;
    const gateStepId = `qa-structural-${randomUUID().slice(0, 8)}`;
    const qaStepId = `qa-semantic-${randomUUID().slice(0, 8)}`;

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Stale Gate Chain WF",
      stepsJson: [
        {
          id: producerStepId, name: "[ACTION] Produce report", agentId,
          dependencies: [], graphWorkProductRequired: true,
        },
        {
          id: gateStepId, name: "[QA] Structural gate", agentId: "",
          type: "tool", qaType: "structural", toolNames: ["validate-report-html"],
          dependencies: [producerStepId], graphWorkProductRequired: false,
        },
        {
          id: qaStepId, name: "[QA] Semantic review", agentId,
          dependencies: [gateStepId], graphWorkProductRequired: false,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, companyId, workflowId: wfId, missionId,
      status: "running", triggeredBy: "test", startedAt: new Date(),
    });

    // T1: producer first completion (iteration 0)
    const producerFirstCompletedAt = new Date(Date.now() - 90_000);
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: producerStepId, issueId: null,
      status: "completed", iterationIndex: 0, completedAt: producerFirstCompletedAt,
    });

    // Gate dispatched + completed against the T1 producer token.
    const gateRequestId = `req-t1-${randomUUID()}`;
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId, issueId: null,
      status: "completed", iterationIndex: 0,
      completedAt: new Date(producerFirstCompletedAt.getTime() + 10_000),
      lastDispatchRequestId: gateRequestId,
      metadata: {
        structuralGateProducerToken: {
          producerStepId, iterationIndex: 0,
          completedAt: producerFirstCompletedAt.toISOString(),
        },
        structuralGateProducerGeneration: 0,
      },
    }).returning();

    // Official PASS verdict bound to the same T1 token.
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id, issueId: null,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${gateRequestId}`,
      payload: {
        kind: "structural_gate_verdict", verdict: "pass",
        producerToken: {
          producerStepId, iterationIndex: 0,
          completedAt: producerFirstCompletedAt.toISOString(),
        },
      },
      createdAt: new Date(producerFirstCompletedAt.getTime() + 10_000),
    });

    // QA-like step still pending, never launched.
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: qaStepId, issueId: null,
      status: "pending", iterationIndex: 0,
    });

    return {
      runId, producerStepId, gateStepId, qaStepId,
      gateRunId: gateRun[0].id, gateRequestId, producerFirstCompletedAt,
    };
  }

  it("requeues a completed gate whose PASS evidence predates a same-iteration producer re-completion, then launches QA", async () => {
    const seeded = await seedChain();

    // Incident step: producer RE-completes within the same iteration at T2 > T1
    // (queued-wakeup revival + duplicate workflow/complete re-stamp).
    const producerRecompletedAt = new Date(Date.now() - 30_000);
    await db.update(workflowStepRuns)
      .set({ completedAt: producerRecompletedAt })
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId))
      .where(eq(workflowStepRuns.stepId, seeded.producerStepId));

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    heartbeatWakeup.mockResolvedValue({ id: "queued-stale-requeue-main" });
    try {
      // Sync #1: must reset the stale gate and redispatch it.
      await syncWorkflowRunState(db, seeded.runId);

      const [gateAfter1] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seeded.gateRunId));
      expect(gateAfter1.status).toBe("running");
      expect(gateAfter1.lastDispatchRequestId).toBeTruthy();
      expect(gateAfter1.lastDispatchRequestId).not.toBe(seeded.gateRequestId);
      const gateMeta1 = (gateAfter1.metadata ?? {}) as Record<string, unknown>;
      const token1 = gateMeta1.structuralGateProducerToken as { completedAt?: string } | undefined;
      expect(token1?.completedAt).toBe(producerRecompletedAt.toISOString());

      // Structured finding recorded (once) in the transition ledger.
      const requeueEvents = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, seeded.gateRunId));
      const finding = requeueEvents.filter((row) => row.eventType === "workflow_gate_requeue");
      expect(finding).toHaveLength(1);
      expect(finding[0].reasonCode).toBe("stale_producer_recompletion");
      expect(finding[0].idempotencyKey).toBe(
        `structural-gate-stale-requeue:${companyId}:${seeded.gateRunId}:${producerRecompletedAt.toISOString()}`,
      );

      // QA is still waiting on the gate (not launched during sync #1).
      const [qaAfter1] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, seeded.runId))
        .where(eq(workflowStepRuns.stepId, seeded.qaStepId));
      expect(qaAfter1.status).toBe("pending");
      expect(qaAfter1.issueId).toBeNull();

      // Gate re-runs and PASSes against the CURRENT (T2) producer generation.
      await completeWorkflowToolStepFromResult(db, {
        companyId, stepRunId: seeded.gateRunId, success: true,
        requestId: gateAfter1.lastDispatchRequestId!, workflowRunId: seeded.runId,
        data: { verdict: "pass" },
      });

      // Sync #2: the semantic QA step must finally launch (deadlock gone).
      await syncWorkflowRunState(db, seeded.runId);

      const [qaAfter2] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, seeded.runId))
        .where(eq(workflowStepRuns.stepId, seeded.qaStepId));
      expect(qaAfter2.issueId).not.toBeNull();
      const [qaIssue] = qaAfter2.issueId
        ? await db.select().from(issues).where(eq(issues.id, qaAfter2.issueId))
        : [];
      expect(qaIssue?.status).toBe("todo");
    } finally {
      setWorkflowToolStepExecutor(null);
      heartbeatWakeup.mockReset();
    }
  });

  it("does not requeue when the gate token already matches the current producer completion (QA launches directly)", async () => {
    const seeded = await seedChain();
    heartbeatWakeup.mockResolvedValue({ id: "queued-stale-requeue" });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    try {
      await syncWorkflowRunState(db, seeded.runId);

      // Gate stays completed with its original request id.
      const [gateAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seeded.gateRunId));
      expect(gateAfter.status).toBe("completed");
      expect(gateAfter.lastDispatchRequestId).toBe(seeded.gateRequestId);

      // No requeue finding was recorded.
      const requeueEvents = await db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.workflowStepRunId, seeded.gateRunId))
        .then((rows) => rows.filter((row) => row.eventType === "workflow_gate_requeue"));
      expect(requeueEvents).toHaveLength(0);

      // Fresh evidence unlocks the QA step immediately.
      const [qaAfter] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, seeded.runId))
        .where(eq(workflowStepRuns.stepId, seeded.qaStepId));
      expect(qaAfter.issueId).not.toBeNull();
    } finally {
      setWorkflowToolStepExecutor(null);
      heartbeatWakeup.mockReset();
    }
  });
});
