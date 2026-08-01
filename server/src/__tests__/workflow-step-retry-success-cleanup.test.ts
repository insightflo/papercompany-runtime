import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  completeWorkflowToolStepFromResult,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry success cleanup tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry success cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-success-cleanup-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("already-completed issue-backed step clears stale live retry state while preserving history", async () => {
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const attemptHistory = [{ retryNumber: 0, failedAt: "2026-07-22T18:00:00.000Z", errorSummary: "boom" }];

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Worker-${stepId}`,
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Issue-backed retry success",
      stepsJson: [{ id: stepId, name: "Worker", agentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: agentId,
      status: "done",
      title: "Retry source",
      body: "",
      source: "workflow",
      originRunId: workflowRunId,
      completedAt: new Date("2026-07-22T18:10:00.000Z"),
    });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      issueId,
      status: "completed",
      completedAt: new Date("2026-07-22T18:10:00.000Z"),
      retryCount: 1,
      metadata: {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: "2026-07-22T18:05:00.000Z",
          sourceRequestId: "retry-1",
          sourceCompletedAt: "2026-07-22T18:05:00.000Z",
          lastErrorSummary: "boom",
        },
        workflowRetryAttempts: attemptHistory,
        workflowRetryExhaustion: { attempts: 99, maxRetries: 98 },
      },
    }).returning();

    await syncWorkflowRunState(db, workflowRunId);

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(after.status).toBe("completed");
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toBeUndefined();
    expect(metadata.workflowRetryAttempts).toEqual(attemptHistory);
  });

  it("issue-less tool success clears live retry state and stale exhaustion while preserving history", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const requestId = `req-${randomUUID()}`;
    const attemptHistory = [{ retryNumber: 1, failedAt: "2026-07-22T19:00:00.000Z", errorSummary: "boom" }];

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Issue-less retry success",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["render"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "running",
      startedAt: new Date("2026-07-22T19:05:00.000Z"),
      lastDispatchRequestId: requestId,
      metadata: {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 2,
          maxRetries: 2,
          nextEligibleAt: "2026-07-22T19:05:00.000Z",
          sourceRequestId: requestId,
          sourceCompletedAt: "2026-07-22T19:05:00.000Z",
          lastErrorSummary: "boom",
        },
        workflowRetryAttempts: attemptHistory,
        workflowRetryExhaustion: { attempts: 5, maxRetries: 4 },
      },
    }).returning();

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: stepRun.id,
      workflowRunId,
      stepId,
      requestId,
      success: true,
      toolName: "render",
      stdout: "ok",
    });

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(after.status).toBe("completed");
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toBeUndefined();
    expect(metadata.workflowRetryAttempts).toEqual(attemptHistory);
  });

  it("structural success clears live retry state while preserving bounded history", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `gate-${randomUUID().slice(0, 6)}`;
    const producerId = `producer-${randomUUID().slice(0, 6)}`;
    const requestId = `req-${randomUUID()}`;
    const producerCompletedAt = new Date("2026-07-22T20:04:00.000Z");
    const attemptHistory = [{
      retryNumber: 1,
      failedAt: "2026-07-22T20:00:00.000Z",
      errorSummary: "temporary infrastructure failure",
    }];

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Structural retry success",
      stepsJson: [
        {
          id: producerId,
          agentId: "producer",
          graphWorkProductRequired: true,
        },
        {
          id: stepId,
          type: "tool",
          qaType: "structural",
          toolNames: ["validate"],
          dependencies: [producerId],
          onFailure: "retry",
          maxRetries: 2,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId: producerId,
      status: "completed",
      completedAt: producerCompletedAt,
      iterationIndex: 0,
    });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "running",
      retryCount: 1,
      startedAt: new Date("2026-07-22T20:05:00.000Z"),
      lastDispatchRequestId: requestId,
      metadata: {
        structuralGateProducerToken: {
          producerStepId: producerId,
          iterationIndex: 0,
          completedAt: producerCompletedAt.toISOString(),
        },
        workflowRetry: {
          state: "dispatching",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: "2026-07-22T20:05:00.000Z",
          sourceRequestId: requestId,
          sourceCompletedAt: "2026-07-22T20:05:00.000Z",
          lastErrorSummary: "temporary infrastructure failure",
        },
        workflowRetryAttempts: attemptHistory,
        workflowRetryExhaustion: { attempts: 3, maxRetries: 2 },
      },
    }).returning();

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: stepRun.id,
      workflowRunId,
      stepId,
      requestId,
      success: true,
      toolName: "validate",
      data: { verdict: "pass" },
    });

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(after.status).toBe("completed");
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toBeUndefined();
    expect(metadata.workflowRetryAttempts).toEqual(attemptHistory);
  });
});
