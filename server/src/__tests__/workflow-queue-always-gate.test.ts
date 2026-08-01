import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  workflowDelegations,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import {
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

// Queue-execution boundary for when:always issue-less tool steps.
// CONTRACT: a when:always edge holds ONLY after its predecessor is terminal.
// processQueuedWorkflowToolStepRuns must reuse the activation logic and NOT dispatch an already-queued
// downstream issue-less tool step while its predecessor (inspection) is still pending/running.
describeEP("queue dispatch gates when:always issue-less tool step on predecessor terminal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("queue-always-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowDelegations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("does not dispatch the queued downstream step while inspection is still running", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    heartbeatWakeup.mockResolvedValue({ id: "queue-always-wake" });
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Queue Always Gate Co",
      issuePrefix: `QA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "inspection-then-dashboard",
      stepsJson: [
        {
          id: "inspection",
          name: "Inspection",
          agentId: "",
          dependencies: [],
          description: "Predecessor issue-less tool step",
          toolNames: ["scan"],
          toolArgs: {},
        },
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          agentId: "",
          dependencies: [],
          description: "Downstream issue-less tool step gated via when:always",
          conditionalDependencies: [{ stepId: "inspection", when: "always" }],
          toolNames: ["sync"],
          toolArgs: {},
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
    });

    const nowIso = new Date().toISOString();
    // Persist: inspection still running (non-terminal).
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "inspection",
      status: "running",
      issueId: null,
      metadata: {},
    });
    // Persist: downstream sync-dashboard already queued/running (admitted earlier when inspection was
    // terminal, then inspection reopened) — selectable by the queue processor.
    const queuedRequestId = `${runId}:sync-dashboard:${Date.now()}`;
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "sync-dashboard",
      status: "running",
      issueId: null,
      lastDispatchRequestId: queuedRequestId,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      metadata: {
        toolInvocation: { requestId: queuedRequestId, toolName: "sync", args: {}, queuedAt: nowIso },
        toolQueue: { status: "queued", queuedAt: nowIso },
      },
    });

    const result = await processQueuedWorkflowToolStepRuns(db);

    // CONTRACT: inspection is non-terminal, so sync-dashboard must NOT be dispatched.
    expect(executeToolStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);

    const dashboardRun = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)))
      .find((row) => row.stepId === "sync-dashboard")!;
    // Still queued (not claimed, no accepted dispatch).
    expect(dashboardRun.status).toBe("running");
    expect(dashboardRun.lastDispatchAcceptedAt).toBeNull();
  });
});
