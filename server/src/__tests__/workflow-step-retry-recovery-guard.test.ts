import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    })),
  })),
  runningProcesses: new Map(),
}));

import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { heartbeatService } from "../services/heartbeat.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry recovery guard tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry recovery guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-recovery-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);


  afterAll(async () => {
    const heartbeat = heartbeatService(db);
    const testAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
    for (const agent of testAgents) {
      await heartbeat.cancelActiveForAgent(agent.id);
    }
    await waitForHeartbeatExecutionsToDrain(db);
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 60_000);

  it("keeps dispatching retry metadata while a live deferred wake exists, then allows one retry after it settles", async () => {
    const workerAgentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const stepRunId = randomUUID();

    await db.insert(agents).values({
      id: workerAgentId,
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
      name: "Retry WF",
      stepsJson: [{ id: stepId, name: "Worker", agentId: workerAgentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: workerAgentId,
      status: "blocked",
      title: "Retry source",
      body: "",
      source: "workflow",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId,
      issueId,
      status: "failed",
      retryCount: 1,
      completedAt: new Date("2026-07-22T10:00:00.000Z"),
      lastDispatchRequestId: "retry-1",
      lastDispatchErrorSummary: "tool failed",
      metadata: {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: "2026-07-22T10:00:00.000Z",
          sourceRequestId: "retry-1",
          sourceCompletedAt: "2026-07-22T10:00:00.000Z",
          lastErrorSummary: "tool failed",
        },
      },
    });
    const [deferredWake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: workerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      issueId,
      status: "deferred_issue_execution",
      requestKind: "workflow_resume",
      payload: { issueId },
    }).returning();

    await syncWorkflowRunState(db, workflowRunId);

    const [suppressed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(suppressed.status).toBe("failed");
    expect(suppressed.retryCount).toBe(1);
    expect(readWorkflowRetryMetadata((suppressed.metadata as Record<string, unknown>).workflowRetry)).toEqual(
      expect.objectContaining({ state: "dispatching", retryNumber: 1, maxRetries: 2 }),
    );
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRunId))).toHaveLength(0);

    await db.update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date("2026-07-22T10:05:00.000Z") })
      .where(eq(agentWakeupRequests.id, deferredWake.id));

    await syncWorkflowRunState(db, workflowRunId);

    const [afterSettlement] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(afterSettlement.retryCount).toBe(2);
    expect(afterSettlement.status).toBe("pending");
    expect(readWorkflowRetryMetadata((afterSettlement.metadata as Record<string, unknown>).workflowRetry)).toEqual(
      expect.objectContaining({ retryNumber: 2, maxRetries: 2 }),
    );
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRunId))).toHaveLength(1);
  });

  it("suppresses the first generic retry while a heartbeat recovery is still running, then schedules one retry after it fails", async () => {
    const workerAgentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const stepRunId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(agents).values({
      id: workerAgentId,
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
      name: "Retry WF heartbeat",
      stepsJson: [{ id: stepId, name: "Worker", agentId: workerAgentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: workerAgentId,
      status: "blocked",
      title: "Retry source",
      body: "",
      source: "workflow",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId,
      issueId,
      status: "failed",
      retryCount: 0,
      completedAt: new Date("2026-07-22T11:00:00.000Z"),
      lastDispatchRequestId: "initial-attempt",
      lastDispatchErrorSummary: "tool failed",
      metadata: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: workerAgentId,
      issueId,
      status: "running",
      startedAt: new Date("2026-07-22T11:01:00.000Z"),
      createdAt: new Date("2026-07-22T11:01:00.000Z"),
    });

    await syncWorkflowRunState(db, workflowRunId);

    const [suppressed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(suppressed.status).toBe("failed");
    expect(suppressed.retryCount).toBe(0);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRunId))).toHaveLength(0);

    await db.update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date("2026-07-22T11:05:00.000Z") })
      .where(eq(heartbeatRuns.id, activeRunId));

    await syncWorkflowRunState(db, workflowRunId);

    const [afterFailure] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(afterFailure.retryCount).toBe(1);
    expect(afterFailure.status).toBe("pending");
    expect(readWorkflowRetryMetadata((afterFailure.metadata as Record<string, unknown>).workflowRetry)).toEqual(
      expect.objectContaining({ retryNumber: 1, maxRetries: 2 }),
    );
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRunId))).toHaveLength(1);
  });
});
