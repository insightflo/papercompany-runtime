import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
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
    await db.delete(instanceSettings);
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

  // [B2 사실망 통일 + 좁은 회복 채널] skip 전파도 launch(findRunnableSteps)와 동일한 v1 사실망(dispatch_ready_at)을
  //   소비해야 한다. 아래 시나리오: produce failed + 비종결(blocked) 실행 이슈 보유(열린 회복 채널 —
  //   사고 재현 형태. 이슈 없는 실패는 v1 대기 규칙 대상이 아니다),
  //   verify pending(legacy success edge), join completed(조건부 edge 로 pass 만 armed).
  async function seedCascadePendingRun(): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cascade Flag Company",
      issuePrefix: `CF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Cascade Worker", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "cascade-flag",
      stepsJson: [
        { id: "produce", name: "Produce", type: "agent", agentId, dependencies: [] },
        { id: "verify", name: "Verify", type: "agent", agentId, dependencies: ["produce"] },
        // join 이 조건부 edge 를 제공해 workflowHasConditionalEdges 게이트를 arm 한다.
        { id: "join", name: "Join", type: "agent", agentId, conditionalDependencies: [{ stepId: "produce", when: "always" }] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId,
      status: "running", triggeredBy: "schedule", startedAt: new Date(), completedAt: null,
    });
    const now = new Date();
    // [B2 좁은 회복 채널] 실패 선행 produce 가 비종결(blocked) 실행 이슈를 보유하게 심는다 —
    //   v1 대기 규칙은 "이슈 보유 실패"에만 적용된다. blocked 는 sync 가 스텝 상태를 failed 로
    //   유지하는 비종결 상태다(desiredStepRunStatusFromIssueStatus).
    const produceIssueId = randomUUID();
    await db.insert(issues).values({
      id: produceIssueId,
      companyId,
      identifier: `CF-${produceIssueId.slice(0, 8)}`,
      title: "Produce",
      status: "blocked",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      // startedAt 을 심어 resetUnlaunchedTerminalStepRuns 의 failed 리셋에서 제외한다.
      { workflowRunId: runId, stepId: "produce", status: "failed", startedAt: now, completedAt: now, issueId: produceIssueId },
      { workflowRunId: runId, stepId: "verify", status: "pending" },
      { workflowRunId: runId, stepId: "join", status: "completed", completedAt: now },
    ]);
    return runId;
  }

  async function flagOn(): Promise<void> {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  }
  async function flagOff(): Promise<void> {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: false } } as never);
  }

  it("flag OFF (legacy): a pending successor of a failed predecessor is cascade-skipped in the same sync", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-cascade-flag-off" });
    try {
      await flagOff();
      const runId = await seedCascadePendingRun();

      await syncWorkflowRunState(db, runId);

      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const verify = rows.find((row) => row.stepId === "verify")!;
      expect(verify.status).toBe("skipped");
      expect((verify.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBe(true);
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      expect(run.status).toBe("failed");
    } finally {
      heartbeatWakeup.mockReset();
    }
  });

  it("flag ON (v1): the same evaluation is waiting — no cascade skip, run not finalized while the successor stays pending", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-cascade-flag-on" });
    try {
      await flagOn();
      const runId = await seedCascadePendingRun();

      await syncWorkflowRunState(db, runId);

      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const verify = rows.find((row) => row.stepId === "verify")!;
      // launch(findRunnableSteps)가 대기하는 상태를 skip 전파도 존중한다 — premature skip 금지.
      // [B2 좁은 회복 채널] 실패 선행이 비종결 이슈(열린 회복 채널)를 보유하므로 v1 대기가 정당하다.
      expect(verify.status).toBe("pending");
      expect((verify.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBeUndefined();
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      // pending 스텝이 남아 있으므로 run 이 failed 로 조기 종결되지 않는다.
      expect(run.status).toBe("running");
    } finally {
      heartbeatWakeup.mockReset();
    }
  });
});
