import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// [T4 quality] RED 단계(스킵 누락)에 generic wake 가 실제 어댑터를 건드리지 않도록만 막는다.
// 스킵이 동작하면 wake 자체가 일어나지 않는다(기존 두 테스트는 tool executor 경로라 무관).
const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));
import {
  agents, agentWakeupRequests, companies, createDb, issues, workflowDefinitions, workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState, setWorkflowToolStepExecutor, completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { reconcileRunnableWorkflowStepWakeups } from "../services/workflow/runnable-step-wakeups-reconciler.js";
import { reconcileWorkflow } from "../services/workflow/reconciler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry reconciler tests: ${support.reason ?? "unsupported"}`);

describeEP("reconcileWorkflow entry point releases due delayed retries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("recon-entry-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ReconEntryCo", status: "active" });
  }, 60_000);
  afterEach(() => { setWorkflowToolStepExecutor(null); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("reconcileWorkflow releases a due delayed issue-less tool retry", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "ReconEntryIssueLess",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 1 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [sr] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: sr.id, success: false,
      requestId: sr.lastDispatchRequestId!, error: "fail",
    });

    const [afterFail] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(afterFail.status).toBe("pending");
    expect(afterFail.retryCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const result = await reconcileWorkflow(db, { timeoutMinutes: 60 });
    expect(result.retryReconciliationsReleased).toBe(1);

    const [afterRecon] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(typeof afterRecon.lastDispatchRequestId).toBe("string");
    expect(afterRecon.lastDispatchRequestId).not.toBeNull();
    expect(afterRecon.lastDispatchRequestId).not.toBe(afterFail.lastDispatchRequestId);
  });

  it("reconcileWorkflow does not release a future delayed retry", async () => {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "ReconEntryFuture",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 3600 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [sr] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: sr.id, success: false,
      requestId: sr.lastDispatchRequestId!, error: "fail",
    });

    const [afterFail] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(afterFail.status).toBe("pending");

    await reconcileWorkflow(db, { timeoutMinutes: 60 });

    const [stillPending] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sr.id));
    expect(stillPending.status).toBe("pending");
    expect(stillPending.lastDispatchRequestId).toBeNull();
  });
});

describeEP("generic runnable-step wakeup reconciler skips workflowRetry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wake-skip-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "WakeSkipCo", status: "active" });
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("skips a due waiting workflowRetry step before assignee resolution", async () => {
    const agentId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: `Agent-${stepId}`, role: "worker",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "WakeSkipWF",
      stepsJson: [{ id: stepId, name: "Worker", agentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 120_000) });
    await db.insert(issues).values({
      id: issueId, companyId, status: "todo", title: "retry-step", body: "",
      source: "workflow", originRunId: runId,
    });
    // Pending issue-backed step carrying a DUE waiting retry.
    const pastEligible = new Date(Date.now() - 60_000).toISOString();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, issueId, status: "pending", retryCount: 1,
      startedAt: new Date(Date.now() - 120_000),
      metadata: {
        workflowRetry: {
          state: "waiting", retryNumber: 1, maxRetries: 2,
          nextEligibleAt: pastEligible, sourceRequestId: null,
          sourceCompletedAt: null, lastErrorSummary: "fail",
        },
      },
    });

    const results = await reconcileRunnableWorkflowStepWakeups(db, 1);
    expect(results).toEqual([]);

    // Zero wakeup rows created — the step was skipped wholesale.
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.issueId, issueId));
    expect(wakes.length).toBe(0);
  });

  it("skips quality-owned steps (metadata.qualityActionId) from generic re-wake", async () => {
    const agentId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: `Agent-${stepId}`, role: "worker",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "WakeSkipQualityWF",
      stepsJson: [{ id: stepId, name: "Worker", agentId }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 120_000) });
    await db.insert(issues).values({
      id: issueId, companyId, status: "todo", title: "quality-step", body: "",
      source: "workflow", originRunId: runId,
    });
    // Pending issue-backed step owned by a quality action — e.g. its quality wake was
    // skipped (agent paused) or swallowed (race loser), so no live quality row exists.
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, issueId, status: "pending",
      startedAt: new Date(Date.now() - 120_000),
      metadata: { qualityActionId: randomUUID() },
    });

    const results = await reconcileRunnableWorkflowStepWakeups(db, 1);
    expect(results).toEqual([]);

    // No generic wakeup row: quality-owned recovery belongs to reconcileQualityIntents
    // (same delivery function, acceptance-recorded), never to a key-less generic wake.
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.issueId, issueId));
    expect(wakes.length).toBe(0);
  });
});
