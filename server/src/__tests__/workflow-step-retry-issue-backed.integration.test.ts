import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry integration tests: ${support.reason ?? "unsupported"}`);

describeEP("issue-backed agent step retry end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-issue-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "IssueRetryCo", status: "active" });
  }, 60_000);

  // No afterEach cleanup — each test uses unique UUIDs and the ephemeral DB
  // is destroyed in afterAll. Deep FK chains from activity_log/heartbeat_runs
  // make per-test deletion unreliable.
  afterAll(async () => { await tempDb?.cleanup(); });

  async function setupAgentStep(maxRetries: number | undefined, onFailure = "retry") {
    const agentId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    await db.insert(agents).values({
      id: agentId, companyId, name: `Agent-${stepId}`, role: "worker",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: `AgentWF-${stepId}`,
      stepsJson: [{ id: stepId, name: "Worker", agentId, onFailure, ...(maxRetries !== undefined ? { maxRetries } : {}) }],
    });
    await db.insert(workflowRuns).values({
      id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test",
    });
    return { agentId, stepId, wfId, runId };
  }

  async function failIssueBackedStep(runId: string, stepId: string) {
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    if (!stepRun.issueId) throw new Error("Step run has no issueId");
    const [issue] = await db.select().from(issues).where(eq(issues.id, stepRun.issueId));
    if (!issue?.assigneeAgentId) throw new Error("Step issue has no assignee");
    const now = new Date();
    await db.update(agentWakeupRequests).set({
      status: "completed",
      finishedAt: now,
      updatedAt: now,
    }).where(eq(agentWakeupRequests.issueId, stepRun.issueId));
    await db.update(heartbeatRuns).set({
      status: "failed",
      finishedAt: now,
      error: "simulated failure",
    }).where(eq(heartbeatRuns.issueId, stepRun.issueId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: issue.assigneeAgentId,
      issueId: stepRun.issueId,
      invocationSource: "test",
      status: "failed",
      startedAt: now,
      finishedAt: now,
      error: "simulated failure",
    });
    // Mark the linked issue as blocked — syncStepRunsFromIssueState maps blocked → failed.
    await db.update(issues).set({
      status: "blocked", updatedAt: now,
    }).where(eq(issues.id, stepRun.issueId));
    return stepRun;
  }

  it("failed issue-backed agent step with onFailure retry schedules retry and wakes the issue", async () => {
    const { stepId, runId } = await setupAgentStep(2);

    // First sync: creates issue and step run
    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    if (!stepRun.issueId) throw new Error("Expected issue-backed step run");
    expect(stepRun.status).toBe("pending");

    // Simulate issue-backed failure
    const failedRun = await failIssueBackedStep(runId, stepId);

    // Sync again: retry pass should schedule a retry
    await syncWorkflowRunState(db, runId);

    const [afterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, failedRun.id));
    expect(afterRetry.retryCount).toBe(1);
    expect(afterRetry.status).toBe("pending");

    // Assert exactly one wake with the retry idempotency key
    const expectedKey = `workflow-step-retry:${stepRun.id}:1`;
    const retryWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, expectedKey));
    expect(retryWakes).toHaveLength(1);
    expect(retryWakes[0]!.issueId).toBe(stepRun.issueId);
    const wakePayload = retryWakes[0]!.payload as Record<string, unknown> | null;
    expect(wakePayload?.forceFreshSession).toBe(true);

    // The waiting → dispatching transition proves wakeExistingWorkflowStepIssue
    // accepted the retry wake for the current request.
    const [afterRetryReloaded] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, failedRun.id));
    const reloadedMeta = afterRetryReloaded.metadata as Record<string, unknown>;
    const reloadedRetry = readWorkflowRetryMetadata(reloadedMeta.workflowRetry);
    if (!reloadedRetry) throw new Error("Expected dispatching retry metadata");
    expect(reloadedRetry.state).toBe("dispatching");

    // Second sync must not duplicate the retry wake
    await syncWorkflowRunState(db, runId);
    const retryWakes2 = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, expectedKey));
    expect(retryWakes2.length).toBe(1);
  });

  it("maxRetries 0 does not schedule a retry or wake for issue-backed step", async () => {
    const { stepId, runId } = await setupAgentStep(0);

    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    await failIssueBackedStep(runId, stepId);
    await syncWorkflowRunState(db, runId);

    const [after] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);

    // No retry transition event for this run
    const events = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled")));
    expect(events.length).toBe(0);

    // No retry wake with the retry idempotency key
    const retryKey = `workflow-step-retry:${stepRun.id}:1`;
    const retryWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, retryKey));
    expect(retryWakes.length).toBe(0);
  });

  it("exhausted retries do not wake after the last configured attempt", async () => {
    const { stepId, runId } = await setupAgentStep(1);

    // First execution → fail → retry 1
    await syncWorkflowRunState(db, runId);
    let sr = await failIssueBackedStep(runId, stepId);
    await syncWorkflowRunState(db, runId);

    // After retry 1: should be pending/running with retryCount=1
    [sr] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(sr.retryCount).toBe(1);

    // Fail again → exhausted
    await failIssueBackedStep(runId, stepId);
    await syncWorkflowRunState(db, runId);

    const [exhausted] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(exhausted.status).toBe("failed");
    expect(exhausted.retryCount).toBe(1); // Not incremented beyond maxRetries=1
    const metadata = exhausted.metadata as Record<string, unknown>;
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toEqual({ attempts: 2, maxRetries: 1 });

    // Only one retry event should exist for this run
    const retryEvents = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled")));
    expect(retryEvents.length).toBe(1);
    // No retry wake for the rejected second retry
    const exhaustedKey = `workflow-step-retry:${sr.id}:2`;
    const noRetryWake = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, exhaustedKey));
    expect(noRetryWake.length).toBe(0);
  });

  it("non-retry onFailure does not schedule a retry for issue-backed step", async () => {
    const { stepId, runId } = await setupAgentStep(3, "abort_workflow");

    await syncWorkflowRunState(db, runId);
    await failIssueBackedStep(runId, stepId);
    await syncWorkflowRunState(db, runId);

    const [after] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
  });
});
