import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  failIssueBackedAttempt,
  retryKey,
  seedIssueBackedRetryWorkflow,
  type TestDb,
} from "./helpers/workflow-step-retry-issue-fixture.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry queue race tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry queue race", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-queue-race-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryQueueRaceCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function step(stepRunId: string) {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    return row;
  }

  async function retryEvents(workflowRunId: string) {
    return db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"),
    ));
  }
  async function waitForWakeRun(wakeupRequestId: string) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeupRequestId));
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for heartbeat run for wake ${wakeupRequestId}`);
  }

  it("marks retry dispatching from exact accepted wake evidence and stays stable on repeated sync", async () => {
    const seeded = await seedIssueBackedRetryWorkflow(db, companyId, { maxRetries: 2 });
    await failIssueBackedAttempt(db, companyId, seeded.stepRunId);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.agentId));

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const [firstWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, retryKey(seeded.stepRunId, 1)));
    expect(firstWake.workflowRunId).toBe(seeded.workflowRunId);
    expect(firstWake.workflowStepRunId).toBe(seeded.stepRunId);
    expect(firstWake.issueId).toBe(seeded.issueId);

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await step(seeded.stepRunId);
    const retryMeta = readWorkflowRetryMetadata((after.metadata as Record<string, unknown>).workflowRetry);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, retryKey(seeded.stepRunId, 1)));
    const events = await retryEvents(seeded.workflowRunId);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, seeded.workflowRunId));
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(retryMeta?.state).toBe("dispatching");
    expect(run.status).toBe("running");
    expect(events).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].id).toBe(firstWake.id);
    expect(wakes[0].issueId).toBe(seeded.issueId);
    expect(["queued", "claimed"]).toContain(wakes[0].status);
    if (wakes[0].status === "queued") expect(wakes[0].runId).toBeNull();
    if (wakes[0].status === "claimed") expect(wakes[0].runId).not.toBeNull();
  });
  it("accepts the real deferred_issue_execution retry wake and stays dispatching across repeated syncs", async () => {
    const seeded = await seedIssueBackedRetryWorkflow(db, companyId, { maxRetries: 2, delaySeconds: 1 });
    await failIssueBackedAttempt(db, companyId, seeded.stepRunId);

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const blockerAgentId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(agents).values({
      id: blockerAgentId,
      companyId,
      name: "Blocker",
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId: blockerAgentId,
      issueId: seeded.issueId,
      invocationSource: "test",
      status: "running",
      startedAt: new Date(),
    });
    await db.update(issues).set({
      executionRunId: blockerRunId,
      executionAgentNameKey: "blocker",
      updatedAt: new Date(),
    }).where(eq(issues.id, seeded.issueId));
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await syncWorkflowRunState(db, seeded.workflowRunId);
    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await step(seeded.stepRunId);
    const retryMeta = readWorkflowRetryMetadata((after.metadata as Record<string, unknown>).workflowRetry);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, retryKey(seeded.stepRunId, 1)));
    const events = await retryEvents(seeded.workflowRunId);
    const deferredWakes = wakes.filter((row) => row.status === "deferred_issue_execution");
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(retryMeta?.state).toBe("dispatching");
    expect(events).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    expect(deferredWakes).toHaveLength(1);
    expect(deferredWakes[0].workflowRunId).toBe(seeded.workflowRunId);
    expect(deferredWakes[0].workflowStepRunId).toBe(seeded.stepRunId);
    expect(deferredWakes[0].issueId).toBe(seeded.issueId);
  });

  it("schedules retry 2 only after live retry execution becomes terminal", async () => {
    const seeded = await seedIssueBackedRetryWorkflow(db, companyId, { maxRetries: 2 });
    await failIssueBackedAttempt(db, companyId, seeded.stepRunId);
    await syncWorkflowRunState(db, seeded.workflowRunId);

    const firstKey = retryKey(seeded.stepRunId, 1);
    const [firstWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, firstKey));
    const firstRun = await waitForWakeRun(firstWake.id);
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentWakeupRequests.id, firstWake.id));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), error: "retry 1 failed" }).where(eq(heartbeatRuns.id, firstRun.id));
    await db.update(issues).set({ status: "blocked", updatedAt: new Date(), executionRunId: null, executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, seeded.issueId));

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await step(seeded.stepRunId);
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.workflowRunId, seeded.workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, seeded.stepRunId),
    ));
    const events = await retryEvents(seeded.workflowRunId);
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(2);
    expect(events).toHaveLength(2);
    expect(wakes.filter((row) => row.idempotencyKey === firstKey)).toHaveLength(1);
    expect(wakes.filter((row) => row.idempotencyKey === retryKey(seeded.stepRunId, 2))).toHaveLength(1);
  });

  it("keeps rejected retry waiting without consuming retry 2", async () => {
    const seeded = await seedIssueBackedRetryWorkflow(db, companyId, {
      maxRetries: 2,
      agentStatus: "paused",
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.agentId));
    await failIssueBackedAttempt(db, companyId, seeded.stepRunId);

    await syncWorkflowRunState(db, seeded.workflowRunId);
    const after = await step(seeded.stepRunId);
    const retryMeta = readWorkflowRetryMetadata((after.metadata as Record<string, unknown>).workflowRetry);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, retryKey(seeded.stepRunId, 1)));
    const retry2Wakes = await db.select().from(agentWakeupRequests).where(
      eq(agentWakeupRequests.idempotencyKey, retryKey(seeded.stepRunId, 2)),
    );
    const events = await retryEvents(seeded.workflowRunId);
    const liveAccepted = wakes.filter((row) => ["queued", "claimed", "deferred_issue_execution", "coalesced"].includes(row.status));
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(retryMeta?.state).toBe("waiting");
    expect(events).toHaveLength(1);
    expect(liveAccepted).toHaveLength(0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].status).toBe("skipped");
    expect(retry2Wakes).toHaveLength(0);
    expect(issue.status).toBe("blocked");
  });
});
