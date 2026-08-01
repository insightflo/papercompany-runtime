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
import { syncWorkflowRunState, setWorkflowToolStepExecutor, completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { reconcileDueWorkflowStepRetries } from "../services/workflow/retry-reconciler.js";
import { isStepRunAwaitingRetry } from "../services/workflow/retry-reconciler.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry reconciler tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry reconciler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-reconciler-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ReconCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("future retry is not released by reconciler", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Delay WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 1, graphRetryDelaySeconds: 3600 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    // Create a failed step with a future retry eligibility
    const futureEligible = new Date(Date.now() + 3600_000).toISOString();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "pending", retryCount: 1,
      metadata: { workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 1, nextEligibleAt: futureEligible, sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: "fail" } },
    });

    const results = await reconcileDueWorkflowStepRetries(db, new Date());
    expect(results.length).toBe(0); // No due retries

    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, stepId));
    expect(step.status).toBe("pending"); // Still waiting
  });

  it("due retry is released by reconciler", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Due WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 1 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    // Create a pending retry that is now due
    const pastEligible = new Date(Date.now() - 1000).toISOString();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "pending", retryCount: 1,
      metadata: { workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: pastEligible, sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: "fail" } },
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    const results = await reconcileDueWorkflowStepRetries(db, new Date());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe("recovered");

    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, stepId));
    expect(typeof step.lastDispatchRequestId).toBe("string");
    expect(step.lastDispatchRequestId).not.toBeNull();
  });

  it("duplicate reconciliation is idempotent: release dispatches once, never re-schedules", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Dup WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    // Fixture manually inserts an ALREADY-scheduled pending retry (retryCount=1,
    // workflowRetry present). The reconciler release dispatches it but must NOT
    // create a new schedule event — the retry was already scheduled.
    const pastEligible = new Date(Date.now() - 1000).toISOString();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "pending", retryCount: 1,
      metadata: { workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: pastEligible, sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null } },
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));

    // First reconcile: dispatches the due retry (waiting → dispatching).
    const results1 = await reconcileDueWorkflowStepRetries(db, new Date());
    expect(results1.length).toBe(1);
    expect(results1[0].action).toBe("recovered");

    const [afterFirst] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, stepId));
    const firstRequestId = afterFirst.lastDispatchRequestId;
    expect(typeof firstRequestId).toBe("string");
    expect(firstRequestId).not.toBeNull();
    const retryAfterFirst = readWorkflowRetryMetadata(
      (afterFirst.metadata as Record<string, unknown>).workflowRetry);
    expect(retryAfterFirst).not.toBeNull();
    expect(retryAfterFirst!.state).toBe("dispatching");

    // Second reconcile: the retry is now `dispatching`, never due → empty result.
    const results2 = await reconcileDueWorkflowStepRetries(db, new Date());
    expect(results2).toEqual([]);

    // Same requestId + dispatching state — no second dispatch.
    const [afterSecond] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, stepId));
    expect(afterSecond.lastDispatchRequestId).toBe(firstRequestId);
    const retryAfterSecond = readWorkflowRetryMetadata(
      (afterSecond.metadata as Record<string, unknown>).workflowRetry);
    expect(retryAfterSecond!.state).toBe("dispatching");

    // Zero schedule events: the retry was already scheduled by the fixture.
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"));
    expect(events.length).toBe(0);
  });

  it("malformed retry metadata produces one bounded failed evidence, never launches", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Malformed WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "pending",
      metadata: { workflowRetry: { state: "waiting" } }, // Missing required fields → malformed
    });

    const results = await reconcileDueWorkflowStepRetries(db, new Date());
    // Exactly one bounded failed-evidence result (never launched, never retried).
    expect(results.length).toBe(1);
    expect(results[0].action).toBe("failed");
    // Generic sanitized reason — no raw metadata leaked into the reason.
    expect(results[0].reason).not.toContain("{");
    expect(results[0].reason).not.toContain("workflowRetry");

    // Step stays pending + untouched (malformed retry is never dispatched).
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, stepId));
    expect(step.status).toBe("pending");

    // No retry transition event was ever written.
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"));
    expect(events.length).toBe(0);
  });

  it("isStepRunAwaitingRetry: valid waiting retry is live regardless of timing", () => {
    const futureMeta = {
      workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() + 60000).toISOString() },
    };
    expect(isStepRunAwaitingRetry(futureMeta)).toBe(true);

    // A due (past-eligible) waiting retry is STILL live work: liveness does
    // not gate on nextEligibleAt — the retry remains awaited until its next
    // attempt actually completes.
    const pastMeta = {
      workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() - 1000).toISOString() },
    };
    expect(isStepRunAwaitingRetry(pastMeta)).toBe(true);

    expect(isStepRunAwaitingRetry(null)).toBe(false);
    expect(isStepRunAwaitingRetry({})).toBe(false);
  });
});

describeEP("Human Operator interlock with retries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-interlock-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "InterlockCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("pending retry step keeps workflow run running", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Running WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 3600 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    // Dispatch, fail, and let retry pass schedule a delayed retry
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: stepRun.id, success: false,
      requestId: stepRun.lastDispatchRequestId!, error: "fail",
    });

    // Workflow run should still be running (delayed retry pending)
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("running");

    // Step should be pending with retry metadata
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(step.status).toBe("pending");
    expect(step.retryCount).toBe(1);
    const meta = step.metadata as Record<string, unknown>;
    expect(meta.workflowRetry).toBeDefined();
  });

  it("exhausted retry leaves step failed", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Exhaust WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 1 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    // Attempt 1: dispatch + fail → retry
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    let [sr] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: sr.id, success: false,
      requestId: sr.lastDispatchRequestId!, error: "fail 1",
    });

    // Attempt 2 (retry): should be dispatched, fail again → exhausted
    [sr] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(sr.retryCount).toBe(1);
    expect(typeof sr.lastDispatchRequestId).toBe("string");
    expect(sr.lastDispatchRequestId).not.toBeNull();
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: sr.id, success: false,
      requestId: sr.lastDispatchRequestId,
      error: "fail 2",
    });

    // Should be failed (exhausted)
    const [exhausted] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(exhausted.status).toBe("failed");
    expect(exhausted.retryCount).toBe(1);
    const metadata = exhausted.metadata as Record<string, unknown>;
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toEqual({ attempts: 2, maxRetries: 1 });
});

});
