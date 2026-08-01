import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import {
  completeWorkflowToolStepFromResult,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry integration tests: ${support.reason ?? "unsupported"}`);

describeEP("issue-less tool step retry through DAG sync", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-sync-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetrySyncCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("failed issue-less tool step with onFailure retry schedules retry and re-dispatches", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);

    // First attempt: dispatch and fail
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    // Tool was dispatched — now complete with failure
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(typeof stepRun.lastDispatchRequestId).toBe("string");

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: stepRun.lastDispatchRequestId!, error: "first failure",
    });

    // Retry scheduling and launch complete synchronously for this issue-less step.
    const [afterFail] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(afterFail.status).toBe("running");
    expect(afterFail.retryCount).toBe(1);
    expect(typeof afterFail.lastDispatchRequestId).toBe("string");
    expect(afterFail.lastDispatchRequestId).not.toBe(stepRun.lastDispatchRequestId);
    expect(readWorkflowRetryMetadata(
      (afterFail.metadata as Record<string, unknown>).workflowRetry,
    )?.state).toBe("dispatching");
  });

  it("exhausts retries after maxRetries and stays failed", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 1 },
    ]);

    // Attempt 1: dispatch + fail
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    let [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: stepRun.lastDispatchRequestId!, error: "fail 1",
    });

    // After retry 1 (retryCount=1), it is re-dispatched with an exact request id.
    [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(stepRun.status).toBe("running");
    expect(stepRun.retryCount).toBe(1);
    expect(typeof stepRun.lastDispatchRequestId).toBe("string");
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: stepRun.lastDispatchRequestId!, error: "fail 2",
    });

    // maxRetries=1 means 1 retry after initial attempt = 2 total attempts.
    // After exhaustion, step should be failed with retryCount=1.
    const [exhausted] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(exhausted.status).toBe("failed");
    expect(exhausted.retryCount).toBe(1);
    const metadata = exhausted.metadata as Record<string, unknown>;
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toEqual({ attempts: 2, maxRetries: 1 });
  });

  it("stale callback from attempt 0 cannot complete attempt 1", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    const oldReqId = stepRun.lastDispatchRequestId!;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: oldReqId, error: "fail",
    });

    // After retry, dispatch state is cleared and replaced
    const [afterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(afterRetry.retryCount).toBe(1);

    // Old callback with old requestId should be rejected
    const staleResult = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: true,
      requestId: oldReqId,
    });
    expect(staleResult).toBeNull();
  });

  it("onFailure non-retry does not schedule generic retry", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "abort_workflow" },
    ]);

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: stepRun.lastDispatchRequestId!, error: "fail",
    });

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
  });

  it("unsupported explicit step type never schedules a generic retry", async () => {
    const stepId = `gate-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "approval_gate", onFailure: "retry", maxRetries: 2 },
    ]);
    // Manually fail the step — unsupported type must not get a retry.
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "failed",
      completedAt: new Date(), lastDispatchAttemptAt: new Date(),
      lastDispatchErrorSummary: "unsupported fail",
      metadata: {},
    });
    await syncWorkflowRunState(db, runId);

    const [step] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(step.status).toBe("failed");
    expect(step.retryCount).toBe(0);
    expect(readWorkflowRetryMetadata((step.metadata as Record<string, unknown>).workflowRetry)).toBeNull();

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId));
    expect(events.filter((e) => e.eventType === "workflow_step_retry_scheduled").length).toBe(0);
  });

  it("malformed workflowRetry on a failed step is cleared, never launched", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 },
    ]);
    // Insert a FAILED step with MALFORMED workflowRetry (missing required fields).
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "failed",
      completedAt: new Date(), lastDispatchAttemptAt: new Date(),
      lastDispatchErrorSummary: "bad meta",
      metadata: { workflowRetry: { state: "waiting" } },
    });
    await syncWorkflowRunState(db, runId);

    const [step] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    // Malformed metadata cleared — step still failed, never retried.
    expect(step.status).toBe("failed");
    expect(step.retryCount).toBe(0);
    expect((step.metadata as Record<string, unknown>).workflowRetry).toBeUndefined();

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId));
    expect(events.filter((e) => e.eventType === "workflow_step_retry_scheduled").length).toBe(0);
  });

  it("concurrency-blocked retry stays waiting, not dispatching", async () => {
    // Blocker: a running step in a separate run occupying the shared slot.
    const blockerStepId = `blocker-${randomUUID().slice(0, 6)}`;
    const blockerWfId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: blockerWfId, companyId, name: "BlockerWF",
      stepsJson: [{ id: blockerStepId, type: "tool", toolNames: ["t"] }],
    });
    await db.insert(workflowRuns).values({ id: blockerRunId, companyId, workflowId: blockerWfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: blockerRunId, stepId: blockerStepId, status: "running",
      startedAt: new Date(), lastDispatchAttemptAt: new Date(),
      metadata: { executionControls: { concurrencyKey: "shared-slot" } },
    });

    // Target: single tool step sharing the concurrency key, limit 1.
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2, graphConcurrencyKey: "shared-slot", graphConcurrencyLimit: 1 },
    ]);
    // Manually fail the target step so the retry pass schedules a retry.
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "failed",
      completedAt: new Date(), lastDispatchAttemptAt: new Date(),
      lastDispatchErrorSummary: "fail",
      metadata: {},
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [target] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    // Retry scheduled but step is concurrency-blocked: stays pending.
    expect(target.status).toBe("pending");
    expect(target.lastDispatchRequestId).toBeNull();
    // Retry stays "waiting" — never flipped to "dispatching".
    const retryMeta = readWorkflowRetryMetadata(
      (target.metadata as Record<string, unknown>).workflowRetry);
    if (!retryMeta) throw new Error("Expected waiting retry metadata");
    expect(retryMeta.state).toBe("waiting");
    const blocked = (target.metadata as Record<string, unknown>).concurrencyBlocked;
    expect(typeof blocked).toBe("object");
    expect(blocked).not.toBeNull();
    expect((blocked as Record<string, unknown>).concurrencyKey).toBe("shared-slot");
  });
});
