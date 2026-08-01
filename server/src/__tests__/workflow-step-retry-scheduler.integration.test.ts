import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { failIssueLessToolStep, setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry integration tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-scheduler-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("resets failed step to pending and increments retryCount", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);

    const result = await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: "tool failed",
    });

    expect(result.result).toBe("scheduled");

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(after.completedAt).toBeNull();
    expect(after.lastDispatchRequestId).toBeNull();
    // Tool result metadata cleared
    const meta = after.metadata as Record<string, unknown>;
    expect(meta.toolResult).toBeUndefined();
    // Retry metadata written
    const retryMeta = readWorkflowRetryMetadata(meta.workflowRetry);
    expect(retryMeta).not.toBeNull();
    expect(retryMeta?.retryNumber).toBe(1);
    expect(retryMeta?.state).toBe("waiting");
  });

  it("reopens the workflow run as running", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);
    // Mark run as failed
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, runId));

    await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: null,
    });

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("running");
    expect(run.completedAt).toBeNull();
  });

  it("creates exactly one idempotent transition event", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);

    await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: null,
    });

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("workflow_step_retry_scheduled");
  });

  it("concurrent calls: one winner, one event, one increment", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);

    const input = {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed" as const, observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: null,
    };

    const results = await Promise.all([
      scheduleWorkflowStepRetry(db, input),
      scheduleWorkflowStepRetry(db, input),
    ]);
    expect(results.map((result) => result.result).sort()).toEqual([
      "already_changed",
      "scheduled",
    ]);

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(after.retryCount).toBe(1);

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events.length).toBe(1);
  });

  it("CAS loss when row already changed returns already_changed or rollback", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);

    // Change the row after snapshot — simulate concurrent modification
    await db.update(workflowStepRuns)
      .set({ lastDispatchRequestId: "concurrent-modification" })
      .where(eq(workflowStepRuns.id, stepRun.id));

    const result = await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: null,
    });
    expect(result.result).toBe("already_changed");
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events.length).toBe(0);
  });

  it("preserves bounded attempt history", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 5 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);

    const result = await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 5, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: "first failure",
    });
    expect(result.result).toBe("scheduled");

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const meta = after.metadata as Record<string, unknown>;
    const history = meta.workflowRetryAttempts as unknown[];
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);
    expect((history[0] as Record<string, unknown>).errorSummary).toBe("first failure");
  });

  it("cancelled run is never reopened: step stays failed, retryCount unchanged, zero events", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    const { stepRun, reqId } = await failIssueLessToolStep(db, runId, stepId);
    // Cancel the run before scheduling.
    await db.update(workflowRuns).set({ status: "cancelled", completedAt: new Date() }).where(eq(workflowRuns.id, runId));

    const result = await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId: runId, stepRunId: stepRun.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: stepRun.completedAt, observedLastDispatchRequestId: reqId,
      observedMetadataSnapshot: stepRun.metadata as Record<string, unknown>,
      errorSummary: null,
    });

    // CAS rolls back: the run-status guard rejects cancelled runs.
    expect(result.result).toBe("already_changed");

    // Run stays cancelled.
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("cancelled");

    // Step stays failed, retryCount unchanged.
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(step.status).toBe("failed");
    expect(step.retryCount).toBe(0);

    // Zero retry events survived the rollback.
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events.length).toBe(0);
  });
});
