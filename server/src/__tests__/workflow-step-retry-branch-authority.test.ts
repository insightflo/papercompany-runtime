import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import { setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry branch authority tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry branch authority", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-branch-authority-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryBranchCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  async function retryEvents(workflowRunId: string) {
    return db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"),
    ));
  }

  async function seedFailedSource(runId: string, sourceId: string, metadata: Record<string, unknown> = {}) {
    const [row] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: sourceId,
      status: "failed",
      completedAt: new Date(),
      startedAt: new Date(),
      lastDispatchAttemptAt: new Date(),
      lastDispatchErrorSummary: "source failed",
      metadata,
    }).returning();
    return row!;
  }

  it("does not let an escalation-only failure target suppress generic retry", async () => {
    const sourceId = `source-${randomUUID().slice(0, 6)}`;
    const escalationId = `escalation-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: sourceId, type: "tool", toolNames: ["source"], onFailure: "retry", maxRetries: 2 },
      { id: escalationId, type: "tool", toolNames: ["escalate"], triggerOn: "escalation", conditionalDependencies: [{ stepId: sourceId, when: "failure" }] },
    ]);
    const sourceRun = await seedFailedSource(runId, sourceId);
    const [escalationRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: escalationId, status: "pending", metadata: {} }).returning();

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [sourceAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceRun.id));
    const [escalationAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, escalationRun!.id));
    expect(sourceAfter.status).toBe("running");
    expect(sourceAfter.retryCount).toBe(1);
    expect(readWorkflowRetryMetadata((sourceAfter.metadata as Record<string, unknown>).workflowRetry)?.state).toBe("dispatching");
    expect(typeof sourceAfter.lastDispatchRequestId).toBe("string");
    expect(escalationAfter.status).toBe("pending");
    expect(await retryEvents(runId)).toHaveLength(1);
  });

  it.each([
    ["failure", "rescue"],
    ["always", "joiner"],
  ] as const)("keeps generic retry authoritative before exhaustion even when an ordinary %s successor is runnable", async (when, targetId) => {
    const sourceId = `source-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: sourceId, type: "tool", toolNames: ["source"], onFailure: "retry", maxRetries: 1 },
      { id: targetId, type: "tool", toolNames: [targetId], conditionalDependencies: [{ stepId: sourceId, when }] },
    ]);
    const sourceRun = await seedFailedSource(runId, sourceId);
    const [targetRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: targetId, status: "pending", metadata: {} }).returning();

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [sourceAfterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceRun.id));
    const [targetAfterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, targetRun!.id));
    expect(sourceAfterRetry.status).toBe("running");
    expect(sourceAfterRetry.retryCount).toBe(1);
    expect(readWorkflowRetryMetadata((sourceAfterRetry.metadata as Record<string, unknown>).workflowRetry)?.state).toBe("dispatching");
    expect(targetAfterRetry.status).toBe("pending");
    expect(await retryEvents(runId)).toHaveLength(1);

    await db.update(workflowStepRuns).set({
      status: "failed",
      completedAt: new Date("2026-07-22T22:00:00.000Z"),
      lastDispatchErrorSummary: "retry exhausted",
    }).where(eq(workflowStepRuns.id, sourceRun.id));
    await syncWorkflowRunState(db, runId);

    const [sourceAfterExhaustion] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceRun.id));
    const [targetAfterExhaustion] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, targetRun!.id));
    expect(sourceAfterExhaustion.status).toBe("failed");
    expect(sourceAfterExhaustion.retryCount).toBe(1);
    expect(targetAfterExhaustion.status).toBe("running");
    expect(typeof targetAfterExhaustion.lastDispatchRequestId).toBe("string");
    expect(await retryEvents(runId)).toHaveLength(1);
  });

  it("clears stale retry metadata after exhaustion when a failure target takes authority", async () => {
    const sourceId = `source-${randomUUID().slice(0, 6)}`;
    const rescueId = `rescue-${randomUUID().slice(0, 6)}`;
    const completedAt = new Date("2026-07-22T21:00:00.000Z");
    const { runId } = await setupWorkflow(db, companyId, [
      { id: sourceId, type: "tool", toolNames: ["source"], onFailure: "retry", maxRetries: 1 },
      { id: rescueId, type: "tool", toolNames: ["rescue"], conditionalDependencies: [{ stepId: sourceId, when: "failure" }] },
    ]);
    const [sourceRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: sourceId,
      status: "failed",
      retryCount: 1,
      completedAt,
      startedAt: new Date("2026-07-22T20:59:00.000Z"),
      lastDispatchAttemptAt: new Date("2026-07-22T20:59:00.000Z"),
      lastDispatchRequestId: "retry-1",
      lastDispatchErrorSummary: "source failed again",
      metadata: {
        workflowRetry: { state: "dispatching", retryNumber: 1, maxRetries: 1, nextEligibleAt: "2026-07-22T20:59:00.000Z", sourceRequestId: "retry-1", sourceCompletedAt: completedAt.toISOString(), lastErrorSummary: "source failed" },
        workflowRetryExhaustion: { attempts: 99, maxRetries: 98 },
      },
    }).returning();
    const [rescueRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: rescueId, status: "pending", metadata: {} }).returning();

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [sourceAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceRun!.id));
    const [rescueAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, rescueRun!.id));
    const metadata = sourceAfter.metadata as Record<string, unknown>;
    expect(sourceAfter.status).toBe("failed");
    expect(sourceAfter.retryCount).toBe(1);
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toEqual({ attempts: 2, maxRetries: 1 });
    expect(rescueAfter.status).toBe("running");
    expect(await retryEvents(runId)).toHaveLength(0);
  });

  it("does not suppress generic retry when a dynamic failure successor is not launched", async () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    const sourceId = `source-${randomUUID().slice(0, 6)}`;
    const rescueId = `rescue-${randomUUID().slice(0, 6)}`;
    const bootstrapId = `bootstrap-${randomUUID().slice(0, 6)}`;
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: `WF-${randomUUID().slice(0, 6)}`,
      executionMode: "dynamic_owner_plan",
      stepsJson: [
        { id: bootstrapId, type: "tool", toolNames: ["bootstrap"] },
        { id: sourceId, type: "tool", toolNames: ["source"], onFailure: "retry", maxRetries: 2 },
        {
          id: rescueId,
          type: "tool",
          toolNames: ["rescue"],
          dependencies: [bootstrapId],
          conditionalDependencies: [{ stepId: sourceId, when: "failure" }],
        },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: bootstrapId,
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const sourceRun = await seedFailedSource(runId, sourceId);
    const [rescueRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: rescueId, status: "pending", metadata: {} }).returning();

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [sourceAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceRun.id));
    const [rescueAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, rescueRun!.id));
    expect(sourceAfter.status).toBe("running");
    expect(sourceAfter.retryCount).toBe(1);
    expect(readWorkflowRetryMetadata((sourceAfter.metadata as Record<string, unknown>).workflowRetry)?.state).toBe("dispatching");
    expect(rescueAfter.status).toBe("pending");
    expect(await retryEvents(runId)).toHaveLength(1);
  });
});
