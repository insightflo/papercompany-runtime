import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

// Same wakeup-mock preamble as workflow-dag-engine.test.ts: the issue creation
// path enqueues assignment wakeups; bind it to a spy for this harness.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping failure-cascade skip sticky tests: ${support.reason ?? "unsupported host"}`);
}

// [GAZ 저녁3 4f8cfacb regression] The 60-min stuck-run reconciler kills pending
//   steps with metadata.failureCascadeSkipped = true, but
//   resetUnlaunchedTerminalStepRuns only excluded controlFlowSkipped — so every
//   sync reset the reconciler's skipped step back to pending, the launch loop
//   never progressed it, and finalizeWorkflowRunState flipped the failed run
//   back to running. Result: skipped↔pending flap every 5 minutes for hours.
// Fix: the reconciler kill must be STICKY — failureCascadeSkipped steps are
//   excluded from the reset exactly like controlFlowSkipped.
describeEP("workflow — failureCascadeSkipped reconciler kill is sticky", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wf-cascade-skip-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedKilledRun(): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cascade Skip Company",
      issuePrefix: `CS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "cascade-skip",
      stepsJson: [
        { id: "produce", name: "Produce", type: "agent", agentId, dependencies: [] },
        { id: "verify", name: "Verify", type: "agent", agentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId,
      status: "running", triggeredBy: "schedule", startedAt: new Date(), completedAt: null,
    });
    const now = new Date();
    // State left by reconcileStuckWorkflowRuns: the blocked pending step was
    // killed as skipped with the failureCascadeSkipped sentinel (issue-less,
    // never started, never dispatched).
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId, stepId: "produce",
        status: "completed", issueId: null, completedAt: now,
      },
      {
        workflowRunId: runId, stepId: "verify",
        status: "skipped", issueId: null, startedAt: null,
        lastDispatchAttemptAt: null, lastDispatchRequestId: null,
        completedAt: now,
        metadata: { failureCascadeSkipped: true },
      },
    ]);
    return runId;
  }

  it("keeps a failureCascadeSkipped step skipped across syncs and lets the run finalize terminally (no flap)", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-cascade-skip" });
    try {
      const runId = await seedKilledRun();

      await syncWorkflowRunState(db, runId);
      const rows1 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const verify1 = rows1.find((row) => row.stepId === "verify")!;
      // Reconciler kill stays sticky: no reset to pending, no new issue launch.
      expect(verify1.status).toBe("skipped");
      expect(verify1.issueId).toBeNull();
      const [run1] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      // All steps terminal → run settles instead of flipping back to running.
      expect(run1.status).toBe("completed");

      // Second sync must be stable (the incident flapped every 5 minutes).
      await syncWorkflowRunState(db, runId);
      const rows2 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const verify2 = rows2.find((row) => row.stepId === "verify")!;
      expect(verify2.status).toBe("skipped");
      expect(verify2.issueId).toBeNull();
      const [run2] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      expect(run2.status).toBe("completed");
    } finally {
      heartbeatWakeup.mockReset();
    }
  });
});
