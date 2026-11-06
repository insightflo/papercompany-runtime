import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueExecutionCards,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// vi.hoisted: mock factories run during ESM import resolution, before plain consts init.
// Production path: wakeExistingWorkflowStepIssue → queueIssueAssignmentWakeup({ heartbeat: heartbeatService(db) })
// → heartbeat.wakeup(...). The heartbeatService mock alone does not always bind in this file's
// import graph, so real enqueueWakeup runs (agent_runtime_state / activity_log FK cleanup failures
// + 0 spy calls). Force the assignment-wakeup helper to use the test spy while keeping its
// real guards/payload shape so existing wakeup assertions stay valid.
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

import { registerStuckWorkflowCase } from "./helpers/workflow-stuck-case.js";
import { cleanWorkflowDagFixture } from "./helpers/workflow-dag-cleanup-fixture.js";
import { createWorkflowDependencyFixture } from "./helpers/workflow-dependency-fixture.js";
import { registerWorkflowDagBackedgeVerdictCases } from "./helpers/workflow-dag-backedge-verdict-cases.js";
import { registerWorkflowDagQaLoopBudgetCases } from "./helpers/workflow-dag-qa-loop-budget-cases.js";
import { registerWorkflowDagQaDownstreamCases } from "./helpers/workflow-dag-qa-downstream-cases.js";
import { registerWorkflowDagQaLoopTerminalCases } from "./helpers/workflow-dag-qa-loop-terminal-cases.js";
import { registerWorkflowDagStaleDispatchCases } from "./helpers/workflow-dag-stale-dispatch-cases.js";
import { registerWorkflowDagMissionSupervisionCases } from "./helpers/workflow-dag-mission-supervision-cases.js";
import { registerWorkflowDagOwnerRecommendationCases } from "./helpers/workflow-dag-owner-recommendation-cases.js";
import { registerWorkflowDagPlanAndCancelCases } from "./helpers/workflow-dag-plan-and-cancel-cases.js";
import { registerWorkflowDagCrossCompanyDelegationCases } from "./helpers/workflow-dag-cross-company-delegation-cases.js";
import { registerWorkflowDagPrerequisiteFailureCases } from "./helpers/workflow-dag-prerequisite-failure-cases.js";
import { registerWorkflowDagFailureGateCases } from "./helpers/workflow-dag-failure-gate-cases.js";
import { registerWorkflowDagMixedControlFlowCases } from "./helpers/workflow-dag-mixed-control-flow-cases.js";
import { registerWorkflowDagToolArgsAndCacheCases } from "./helpers/workflow-dag-tool-args-and-cache-cases.js";
import { registerWorkflowDagToolConcurrencyAndRetentionCases } from "./helpers/workflow-dag-tool-concurrency-and-retention-cases.js";
import { registerWorkflowDagAllToolWorkflowCases } from "./helpers/workflow-dag-all-tool-workflow-cases.js";
import { registerWorkflowDagToolRegistryEventCases } from "./helpers/workflow-dag-tool-registry-event-cases.js";
import { issueService } from "../services/issues.ts";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepReadinessChecker,
  setWorkflowToolStepExecutor,
  syncWorkflowRunForIssue,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { reconcileDeadlockedWorkflowRuns, reconcileRunnableWorkflowStepWakeups, reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
import { buildRuntimeSearchPathPermissions } from "../services/runtime-search-path-permissions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow DAG tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeWorkflowRun issue lifecycle parity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const { executeDependencyWorkflow, completeStepIssue, recordWorkflowVerdictForIssue,
    getStepIssue, seedArtifactRun, seedArtifactComment } = createWorkflowDependencyFixture(() => db, heartbeatWakeup);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-dag-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await cleanWorkflowDagFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  registerStuckWorkflowCase(() => db);

  it("does not mark unlaunched downstream tool steps as failed when a stuck run is terminalized", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stuck Tool Cascade Company",
      issuePrefix: `ST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "stuck-tool-cascade",
      stepsJson: [
        { id: "inspection", name: "Inspection", type: "agent", agentId: "", dependencies: [] },
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          type: "tool",
          toolNames: ["gazua.oracle-data-sync"],
          dependencies: ["inspection"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "inspection",
        status: "failed",
        completedAt: new Date("2020-01-01T01:00:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "sync-dashboard",
        status: "pending",
        metadata: { graphWorkProductRequired: false },
      },
    ]);

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");
    const storedSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(storedSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "inspection", status: "failed" }),
      expect.objectContaining({
        stepId: "sync-dashboard",
        status: "skipped",
        startedAt: null,
        lastDispatchAttemptAt: null,
        lastDispatchRequestId: null,
        metadata: expect.objectContaining({ failureCascadeSkipped: true }),
      }),
    ]));
  });

  it("does not fail pending downstream steps while a linked workflow issue is still active", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Active Workflow Company",
      issuePrefix: `AW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Worker",
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "active-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "AW-1",
      title: "Collect",
      status: "in_progress",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect",
        issueId,
        status: "running",
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "synthesize",
        status: "pending",
      },
    ]);

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toEqual([
      expect.objectContaining({
        runId,
        action: "skipped",
        reason: "Active workflow step execution is still running",
      }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
    expect(storedRun?.completedAt).toBeNull();
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "collect", status: "running" }),
      expect.objectContaining({ stepId: "synthesize", status: "pending", completedAt: null }),
    ]));
  });

  it("deadlock fast-path: converges a legacy run with a failed predecessor and unreachable pending steps without waiting 60 min", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const linkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Deadlock Workflow Company",
      issuePrefix: `DL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "deadlock-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
        { id: "report", name: "Report", type: "agent", agentId: "", dependencies: ["synthesize"] },
      ],
    });
    // startedAt is 6 min ago -> past the 5-min deadlock settling gate, but far short
    // of the 60-min stuck gate. Only the deadlock fast-path can converge it.
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: linkedIssueId,
      companyId,
      identifier: "DL-1",
      title: "Report",
      // [B3] 회복 채널이 닫힌 종결(cancelled) 이슈 — 기존 deadlock 처리(skip + run failed 수렴)가 유지되는 회귀.
      status: "cancelled",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "synthesize", status: "pending" },
      { workflowRunId: runId, stepId: "report", status: "pending", issueId: linkedIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const synthesize = steps.find((step) => step.stepId === "synthesize");
    expect(synthesize?.status).toBe("skipped");
    expect((synthesize?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);

    const report = steps.find((step) => step.stepId === "report");
    expect(report?.status).toBe("skipped");
    expect((report?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);

    // Terminal (cancelled) linked issue: existing deadlock handling preserved — the step is
    // skipped but the closed recovery channel is not re-blocked and no new comment is written.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, linkedIssueId));
    expect(storedIssue?.status).toBe("cancelled");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssueId));
    expect(comments).toHaveLength(0);
  });

  it("deadlock fast-path holds pending steps with non-terminal linked issues and keeps the recovery channel open", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const linkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Deadlock Hold Company",
      issuePrefix: `DH${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "deadlock-hold-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
        { id: "report", name: "Report", type: "agent", agentId: "", dependencies: ["synthesize"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: linkedIssueId,
      companyId,
      identifier: "DL-2",
      title: "Report",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "synthesize", status: "pending" },
      { workflowRunId: runId, stepId: "report", status: "pending", issueId: linkedIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    // [B3] 회복 가능한(todo) 실행 이슈를 가진 pending 스텝은 최종 skip 으로 확정하지 않는다 —
    //   대기 사유를 구조화 결과로 남기고 run 종결도 보류한다.
    expect(result).toEqual([
      expect.objectContaining({ runId, action: "skipped", reason: expect.stringContaining("non-terminal") }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
    expect(storedRun?.completedAt).toBeNull();

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    // 이슈 없는 도달 불가 스텝은 기존대로 수렴한다(진짜 교착 수렴 보존).
    const synthesize = steps.find((step) => step.stepId === "synthesize");
    expect(synthesize?.status).toBe("skipped");
    expect((synthesize?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);
    // 이슈 보유 스텝은 pending 유지.
    const report = steps.find((step) => step.stepId === "report");
    expect(report?.status).toBe("pending");

    // 회복 채널이 열려 있다 — 이슈 상태 변경/코멘트 없음.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, linkedIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssueId));
    expect(comments).toHaveLength(0);
  });
  describe("revive stale controlFlowSkipped after predecessor recovery (plain dependsOn)", () => {
    async function seedStaleSkipRun(normalizeGovStatus: "completed" | "failed"): Promise<string> {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const workflowId = randomUUID();
      const runId = randomUUID();
      heartbeatWakeup.mockResolvedValue({ id: "queued-revive-skip" });
      await db.insert(companies).values({
        id: companyId,
        name: "Revive Skip Company",
        issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Revive Skip Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      // Plain dependsOn only — no conditional edge. select-targets requires three normalize steps.
      await db.insert(workflowDefinitions).values({
        id: workflowId,
        companyId,
        name: "merge-candidates",
        stepsJson: [
          { id: "n-gov", name: "Normalize Government Iris", type: "agent", agentId, dependencies: [] },
          { id: "n-a", name: "Normalize A", type: "agent", agentId, dependencies: [] },
          { id: "n-b", name: "Normalize B", type: "agent", agentId, dependencies: [] },
          { id: "select-targets", name: "Select Targets", type: "agent", agentId, dependencies: ["n-gov", "n-a", "n-b"] },
        ],
      });
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        companyId,
        status: "running",
        triggeredBy: "schedule",
        startedAt: new Date(),
        completedAt: null,
      });
      const now = new Date();
      // Stale state left when select-targets was force-skipped at first failure (deadlock-reconciler
      // sentinel) while n-gov later either recovered (completed) or stayed failed.
      await db.insert(workflowStepRuns).values([
        {
          workflowRunId: runId,
          stepId: "n-gov",
          status: normalizeGovStatus,
          startedAt: normalizeGovStatus === "failed" ? now : null,
          completedAt: normalizeGovStatus === "completed" ? now : null,
        },
        { workflowRunId: runId, stepId: "n-a", status: "completed", completedAt: now },
        { workflowRunId: runId, stepId: "n-b", status: "completed", completedAt: now },
        { workflowRunId: runId, stepId: "select-targets", status: "skipped", completedAt: now, metadata: { controlFlowSkipped: true } },
      ]);
      return runId;
    }

    it("re-evaluates a stale controlFlowSkipped step once its plain dependencies recover to completed", async () => {
      const runId = await seedStaleSkipRun("completed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      // Revived: no longer skipped (now pending/created for launch).
      expect(select.status).toBe("pending");
    });

    it("keeps a controlFlowSkipped step skipped while a plain dependency is still failed", async () => {
      const runId = await seedStaleSkipRun("failed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      // Legitimate skip preserved: predecessor still failed, activation not runnable.
      expect(select.status).toBe("skipped");
    });

    it("flag ON keeps the stale controlFlowSkipped step skipped until predecessors are dispatch-ready (same fact map as launch)", async () => {
      // [B2 사실망 통일] 완료 선행이 dispatch_ready_at 없이 완료된 상태에서 v1 이 켜지면 launch 가
      //   대기하듯 revive 도 부활하지 않는다(플래그 off 의 revive 와 기대가 다르다).
      await db.delete(instanceSettings);
      await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
      const runId = await seedStaleSkipRun("completed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      expect(select.status).toBe("skipped");
      expect((select.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBe(true);
    });
  });

  it("deadlock fast-path: does NOT converge a PARALLEL dag when an independent branch is still runnable (only the failed branch's downstream is unreachable)", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const branchBIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Parallel DAG Company",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Two independent branches. branchA: a -> a2. branchB: b -> b2.
    // a2 depends on a (failed) -> unreachable. b is an entry step (runnable);
    // b2 depends on b (still pending) -> waiting, not unreachable.
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "parallel-dag",
      stepsJson: [
        { id: "a", name: "A", type: "agent", agentId: "", dependencies: [] },
        { id: "a2", name: "A2", type: "agent", agentId: "", dependencies: ["a"] },
        { id: "b", name: "B", type: "agent", agentId: "", dependencies: [] },
        { id: "b2", name: "B2", type: "agent", agentId: "", dependencies: ["b"] },
      ],
    });
    // startedAt is 6 min ago -> past the 5-min settling gate. Branch A failed,
    // branch B has NOT been picked up by the launcher yet (still pending).
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: branchBIssueId,
      companyId,
      identifier: "PD-1",
      title: "B",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "a", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "a2", status: "pending" },
      { workflowRunId: runId, stepId: "b", status: "pending", issueId: branchBIssueId },
      { workflowRunId: runId, stepId: "b2", status: "pending" },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    // Not deadlocked: branch B is still runnable. The run must keep going.
    expect(result).toEqual([]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const findStep = (stepId: string) => steps.find((step) => step.stepId === stepId);

    // The independent parallel branch is NOT skipped/blocked -- it stays runnable.
    const branchB = findStep("b");
    expect(branchB?.status).toBe("pending");
    expect((branchB?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();
    const branchB2 = findStep("b2");
    expect(branchB2?.status).toBe("pending");
    expect((branchB2?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();

    // The failed branch's downstream is also left untouched this tick (the reconciler
    // does not partially converge; the launcher/normal skip-pass handles a2). The
    // invariant under test is only that nothing is wrongly force-skipped/blocked.
    expect(findStep("a2")?.status).toBe("pending");

    // The linked issue on the runnable branch is NOT blocked.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, branchBIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, branchBIssueId));
    expect(comments).toHaveLength(0);
  });

  it("reconciler queues a missing workflow_resume wakeup for a runnable todo step", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-workflow-resume" });

    await db.insert(companies).values({
      id: companyId,
      name: "Runnable Wakeup Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runnable Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "runnable-wakeup-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId, dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RW-1",
      title: "Collect",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "collect",
      status: "pending",
      issueId,
    });

    const result = await reconcileRunnableWorkflowStepWakeups(db);

    expect(result).toEqual([expect.objectContaining({
      runId,
      action: "recovered",
      reason: expect.stringContaining("Queued missing workflow_resume wakeup"),
    })]);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId,
        mutation: "workflow_resume",
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId: "collect",
      }),
    }));
  });

  it("deadlock fast-path: does NOT converge an injected delivery verification gate with a reachable todo issue", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const gateIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Delivery Gate Deadlock Company",
      issuePrefix: `DG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "cloudflare-delivery",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "publish", name: "Publish Cloudflare Pages site", type: "agent", agentId: "", dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: gateIssueId,
      companyId,
      identifier: "DG-1",
      title: "Verify public delivery",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "publish", status: "completed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "delivery-verification-gate", status: "pending", issueId: gateIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const gate = steps.find((step) => step.stepId === "delivery-verification-gate");
    expect(gate?.status).toBe("pending");
    expect((gate?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, gateIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, gateIssueId));
    expect(comments).toHaveLength(0);
  });

  it("deadlock fast-path: converges a dynamic owner plan when pending declarations are not launcher-eligible", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Dynamic Owner Deadlock Company",
      issuePrefix: `DO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "dynamic-owner-plan",
      executionMode: "dynamic_owner_plan",
      stepsJson: [
        { id: "plan", name: "Plan", type: "agent", agentId: "", dependencies: [] },
        { id: "owner-escalation", name: "Owner escalation", type: "agent", agentId: "", triggerOn: "escalation", dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "plan", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "owner-escalation", status: "pending" },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const escalation = steps.find((step) => step.stepId === "owner-escalation");
    expect(escalation?.status).toBe("skipped");
    expect((escalation?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);
  });

  it("[P7] does not kill a rework iteration while a workflow wakeup is live", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const qaIssueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Iterating Loop Company",
      issuePrefix: `IL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "iterating-loop",
      stepsJson: [
        { id: "produce", name: "Produce", type: "agent", agentId: "", dependencies: [] },
        { id: "qa", name: "QA", type: "agent", agentId: "", dependencies: ["produce"] },
      ],
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Loop Worker", role: "worker" });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    await db.insert(issues).values({ id: qaIssueId, companyId, title: "QA", status: "todo" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", status: "completed", iterationIndex: 1, startedAt: new Date("2020-01-01T00:00:00.000Z"), completedAt: new Date("2020-01-01T00:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa", issueId: qaIssueId, status: "pending", iterationIndex: 1 },
    ]);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      issueId: qaIssueId,
      workflowRunId: runId,
      source: "test",
      reason: "workflow_resume",
      status: "queued",
    });

    const result = await reconcileStuckWorkflowRuns(db, 60);
    expect(result).toEqual([
      expect.objectContaining({ runId, action: "skipped", reason: expect.stringContaining("actively executing") }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
  });

  it("creates workflow definitions from plugin UI step payloads", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Plugin UI Workflow",
      steps: [
        {
          id: "qa-step",
          title: "QA step",
          description: "Use this step only for QA usability verification.",
          type: "agent",
          dependsOn: [],
        },
      ] as never,
    });

    expect(definition.name).toBe("Plugin UI Workflow");
    expect(definition.steps).toEqual([
      expect.objectContaining({
        id: "qa-step",
        name: "QA step",
        dependencies: [],
      }),
    ]);
  });

  it("adds QA request-changes back-edges to reusable workflow definitions at create time", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow QA Loop Company",
      issuePrefix: `QL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Reusable QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(definition.steps.find((step) => step.id === "validate-report")?.conditionalDependencies).toBeUndefined();
  });

  it("treats final inspection as QA, removes its workProduct gate, and adds a rework back-edge", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Final Inspection Workflow Company",
      issuePrefix: `FI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "Inspector", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Final Inspection Workflow",
      steps: [
        { id: "materialize-report", name: "Materialize report", agentId: producerAgentId, dependencies: [], graphWorkProductRequired: true },
        { id: "qa-dashboard-html", qaType: "semantic", name: "Validate report HTML", agentId: qaAgentId, dependencies: ["materialize-report"] },
        { id: "signal-analysis", name: "Signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "strategy-summary", name: "Strategy summary", agentId: producerAgentId, dependencies: ["signal-analysis"] },
        { id: "inspection", qaType: "semantic", name: "Final inspection", agentId: qaAgentId, dependencies: ["signal-analysis", "strategy-summary", "qa-dashboard-html"], graphWorkProductRequired: true },
      ],
    });

    expect(definition.steps.find((step) => step.id === "materialize-report")?.conditionalDependencies).toEqual([
      { stepId: "qa-dashboard-html", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
      { stepId: "inspection", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(definition.steps.find((step) => step.id === "strategy-summary")?.conditionalDependencies).toBeUndefined();
    expect(definition.steps.find((step) => step.id === "inspection")?.graphWorkProductRequired).toBe(false);
  });

  it("preserves author-defined QA back-edges instead of replacing their loop cap", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Explicit Loop Company",
      issuePrefix: `EL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Explicit QA Loop Workflow",
      steps: [
        {
          id: "produce-report",
          name: "Produce report",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 }],
        },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 },
    ]);
  });

  it("adds QA request-changes back-edges when reusable workflow definitions are updated", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Update Loop Company",
      issuePrefix: `UL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Updated QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
      ],
    });
    const updated = await workflowService.updateDefinition(db, definition.id, {
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(updated?.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });

  it("rejects new workflow tool references when the tool system is unavailable", async () => {
    const companyId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin is not installed.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Toolless Workflow",
      issuePrefix: `TL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Unavailable Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin is not installed.");
  });

  it("rejects new workflow tool references that are not selectable", async () => {
    const companyId = randomUUID();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Missing Tool Workflow",
      issuePrefix: `MT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Missing Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow('Workflow tool "collect-data" is unavailable.');
  });

  it("preflights existing tool workflows before creating a new run", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin worker is not running.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Existing Tool Workflow",
      issuePrefix: `ET${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Existing Tool Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          dependencies: [],
          toolNames: ["collect-data"],
        },
      ],
    });

    await expect(workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      triggerSource: "manual",
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin worker is not running.");

    const runs = await db.select().from(workflowRuns);
    expect(runs).toEqual([]);
  });

  it("creates workflow entry step issues through the common lifecycle path and keeps the run active", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "draft-plan";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Roadmap Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Draft {$date} plan",
          agentId,
          dependencies: [],
          description: "Prepare the {$runDate} implementation plan",
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-12",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    expect(result.stepRuns).toHaveLength(1);
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();

    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue).toMatchObject({
      companyId,
      title: "Draft 2026-06-12 plan",
      description: expect.stringContaining(`workflowRunId: ${runId}`),
      status: "todo",
      assigneeAgentId: agentId,
      missionId: null,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    expect(createdIssue?.identifier).toMatch(/^WF[A-Z0-9]+-1$/);
    expect(createdIssue?.description).toContain("Prepare the 2026-06-12 implementation plan");
    expect(createdIssue?.description).toContain(`workflowDefinitionId: ${workflowId}`);
    expect(createdIssue?.description).toContain("missionId: none");
    expect(createdIssue?.description).toContain(`stepId: ${stepId}`);
    expect(createdIssue?.description).toContain("dependencyStepIds: []");
    expect(createdIssue?.description).toContain("Treat issue ids from other missions or workflow runs as out of scope");
    // planning step is NOT a workProduct producer (graphWorkProductRequired unset) →
    // dag-engine must NOT inject the deliverable/registration contract.
    expect(createdIssue?.description).not.toContain("Deliverable output (use exactly this directory)");
    expect(createdIssue?.description).not.toContain("WorkProduct registration contract:");
    expect(createdIssue?.description).not.toContain("[ARTIFACT]:");
    expect(createdIssue?.description).not.toContain("POST /api/issues/{issueId}/work-products");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, createdIssue!.id))
      .then((rows) => rows.find((row) => row.action === "issue.created") ?? null);
    expect(activity).toMatchObject({
      companyId,
      actorType: "system",
      actorId: `workflow:${workflowId}`,
      action: "issue.created",
      entityType: "issue",
      entityId: createdIssue!.id,
    });
    expect(activity?.details).toEqual({
      title: "Draft 2026-06-12 plan",
      identifier: createdIssue!.identifier,
    });

    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: createdIssue!.id,
        mutation: "create",
        issueExecutionCardId: expect.any(String),
        issueExecutionCardHash: expect.any(String),
      }),
      requestedByActorType: "system",
      requestedByActorId: `workflow:${workflowId}`,
      contextSnapshot: expect.objectContaining({
        issueId: createdIssue!.id,
        source: "workflow.dispatch",
        paperclipIssueExecutionCardId: expect.any(String),
        paperclipIssueExecutionCardHash: expect.any(String),
      }),
    }));

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("running");
  });

  it("renders {$runMetadata.<key>} tokens in step name and description from run metadata", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "summarize-video";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Run Metadata Workflow",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Metadata Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "YouTube Summary",
      stepsJson: [
        {
          id: stepId,
          name: "Summarize {$runMetadata.videoId}",
          agentId,
          dependencies: [],
          description: "Input URL: {$runMetadata.url} on {$runDate}; missing stays {$runMetadata.notDeclared}",
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      triggerSource: "manual",
      status: "pending",
      runDate: "2026-08-27",
      metadata: { videoId: "dQw4w9WgXcQ", url: "https://example.com/watch?v=dQw4w9WgXcQ" },
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();

    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.title).toBe("Summarize dQw4w9WgXcQ");
    expect(createdIssue?.description).toContain(
      "Input URL: https://example.com/watch?v=dQw4w9WgXcQ on 2026-08-27; missing stays {$runMetadata.notDeclared}",
    );
  });

  it("injects deliverable + registration contract only for workProduct steps (graphWorkProductRequired=true)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "produce-report";
    const workProductRoot = `/tmp/wf-workproduct-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-workproduct" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip WorkProduct",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "WorkProduct mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Producer Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Produce report",
          agentId,
          dependencies: [],
          description: "Write the report file.",
          graphWorkProductRequired: true,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-12",
    });

    await executeWorkflowRun(db, runId);

    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();
    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);

    // graphWorkProductRequired=true → dag-engine injects the full contract.
    expect(createdIssue?.description).toContain("Deliverable output (use exactly this directory):");
    expect(createdIssue?.description).toContain(workProductRoot);
    expect(createdIssue?.description).toContain("Workflow API closeout:");
    expect(createdIssue?.description).toContain("/workflow/artifacts");
    expect(createdIssue?.description).toContain("/workflow/complete");
    expect(createdIssue?.description).toContain("WorkProduct registration contract:");
    expect(createdIssue?.description).toContain("only the Workflow API registers a work product");
    expect(createdIssue?.description).not.toContain("[ARTIFACT]:");
    expect(createdIssue?.description).toContain("Evidence explanation quality");
    expect(createdIssue?.description).toContain("source content -> observation -> interpretation -> conclusion");
    expect(createdIssue?.description).toContain("private traceability");
    expect(createdIssue?.description).toContain("interpretation");
    // AREA-3: the QA/validator guidance line is gated on !graphWorkProductRequired,
    // so a producer step must NOT receive it — it would contradict the [ARTIFACT]
    // FINAL LINE RULE above. QA/validator steps (flag=false) still get the line.
    expect(createdIssue?.description).not.toContain("For QA/validator steps");
    expect(createdIssue?.description).not.toContain("POST /api/issues/{issueId}/work-products");
  });

  it("writes QA step grading criteria to a rubric markdown file and gives the QA agent only that path", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-qa-rubric-${companyId}`;
    const criteriaText = [
      "Report Validator step.",
      "Check Top25 rank coverage, duplicate/missing entries, source URL presence,",
      "collection timestamp, fallback notes, confidence labels, and whether any item should be excluded from synthesis.",
      "Return PASS or REQUEST_CHANGES with exact gaps.",
    ].join(" ");

    heartbeatWakeup.mockResolvedValue({ id: "queued-qa-rubric" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip QA Rubric",
      issuePrefix: `QR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "Producer Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Agent",
        role: "validator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: producerAgentId,
      title: "QA rubric mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "QA Rubric Workflow",
      stepsJson: [
        {
          id: "collect-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write evidence.json.",
          graphWorkProductRequired: true,
        },
        {
          id: "audit-evidence", qaType: "semantic",
          name: "Audit evidence",
          agentId: qaAgentId,
          dependencies: ["collect-evidence"],
          description: criteriaText,
          graphWorkProductRequired: false,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-25",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const producerStepRun = stepRuns.find((row) => row.stepId === "collect-evidence")!;
    const producerIssueId = producerStepRun.issueId!;

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      },
    });
    await issueService(db).update(producerIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, producerIssueId);

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qaStepRun = stepRuns.find((row) => row.stepId === "audit-evidence")!;
    expect(qaStepRun.issueId).toBeTruthy();

    const [qaIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, qaStepRun.issueId!));

    const qaDescription = qaIssue.description ?? "";
    expect(qaDescription).toContain("QA grading rubric:");
    expect(qaDescription).toContain("qa-rubric.md");
    expect(qaDescription).toContain("Workflow API closeout:");
    expect(qaDescription).toContain("/workflow/verdict");
    expect(qaDescription).toContain("/workflow/complete");
    // [findings 계약 교육] closeout 도 findings 병기 계약을 가르친다 — 루브릭과 동일 스키마.
    expect(qaDescription).toContain("`REQUEST_CHANGES` requires `findings`");
    expect(qaDescription).toContain("one entry per blocking defect with `id`, `summary`, `layer`");
    expect(qaDescription).toContain("`REQUEST_CHANGES` requires one findings entry per blocking defect");
    // [remediations 계약 교육] 클로짓아웃 표면도 가르친다 — 루브릭과 동일 계약.
    expect(qaDescription).toContain("`REQUEST_CHANGES` may attach `remediations` only when every defect is a purely mechanical string replacement");
    expect(qaDescription).toContain("`find` must occur exactly once in the file");
    expect(qaDescription).not.toContain("Check Top25 rank coverage");
    expect(qaDescription).not.toContain("collection timestamp, fallback notes");
    expect(qaDescription).not.toContain("Deliverable output (use exactly this directory):");
    expect(qaDescription).not.toContain("[ARTIFACT]:");

    const rubricPath = qaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    expect(fs.existsSync(rubricPath!)).toBe(true);
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Check Top25 rank coverage");
    expect(rubric).toContain("Return PASS or REQUEST_CHANGES with exact gaps.");
    expect(rubric).toContain(`workflowRunId: ${runId}`);
    expect(rubric).toContain("collect-evidence");
    expect(rubric).toContain("evidence.json");
    expect(rubric).toContain("Mission quality contract");
    expect(rubric).toContain("purpose-fitness first");
    expect(rubric).toContain("Adaptive quality profile");
    expect(rubric).toContain("Outcome review standard");
    expect(rubric).toContain("REQUEST_CHANGES only for an observed blocking defect");
    expect(rubric).toContain("A failed checklist item or probe is evidence to assess, not an automatic blocking verdict");
    expect(rubric).toContain("Return `PASS` when no blocking defect remains");
    // [findings 계약 교육] REQUEST_CHANGES 는 findings 병기가 공식 계약 — reason-글쩍 단독 가르침은 소멸.
    expect(rubric).toContain("must carry `findings` — one entry per blocking defect");
    // [remediations 계약 교육] 순수 기계적 결함의 remediations 계약도 엔진 표면이 가르친다
    //   — 참조 파일 수작업 오버레이(MECHANICAL_REMEDIATION_CONTRACT_V1) 제거 근거.
    expect(rubric).toContain("also attach `remediations` to the REQUEST_CHANGES body");
    expect(rubric).toContain("{\"op\":\"string_replace\"");
    expect(rubric).toContain("max 20 items");
    expect(rubric).toContain("falls back to producer rework");
    expect(rubric).toContain("do not attach `remediations`");
    expect(rubric).toContain("`artifact` = the produced deliverable, `source_data` = upstream source data");
    expect(rubric).toContain("mislayered findings are themselves recorded as verdict-quality defects");
    expect(rubric).toContain("Keep `reason` to concise human context");
    expect(rubric).not.toContain("REQUEST_CHANGES: <specific gaps>");
    expect(rubric).not.toContain("End the final answer with one clear verdict");
    expect(rubric).not.toContain("Return `PASS` only when the dependency workProducts meet every criterion above");
    expect(rubric).not.toContain("when any criterion is missing, ambiguous, stale, or unsupported");
    expect(rubric).not.toContain("5-axis scoring");
    expect(rubric).toContain("Evidence explanation quality");
    expect(rubric).toContain("source content -> observation -> interpretation -> conclusion");
    expect(rubric).toContain("storage fields, internal filenames, manifests, or workProduct paths");
    // [Verification Before Completion] QA verdict must be based on fresh claim/evidence checks.
    expect(rubric).toContain("Verification Before Completion");
    expect(rubric).toContain("fresh evidence");
    expect(rubric).toContain("direct dependency workProducts");
    expect(rubric).not.toContain("Identify every completion claim");
    expect(rubric).not.toContain("final user-visible or machine-consumed output contract");
    expect(rubric).toContain("notVerified");
  });

  it("renders the step dispatch contract in issue instructions and QA rubric dependency contracts", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-step-contract-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-step-contract" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Step Contract",
      issuePrefix: `SC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "Producer Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Agent",
        role: "validator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: producerAgentId,
      title: "Step contract mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Step Contract Workflow",
      stepsJson: [
        {
          id: "collect-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write evidence.json.",
          graphWorkProductRequired: true,
          contract: {
            preconditions: ["Data source brief is registered"],
            postconditions: ["evidence.json exists in the step output directory"],
            undefinedBehaviors: ["If the data source is unreachable, evidence content is undefined — report blocked instead of guessing"],
          },
        },
        {
          id: "summarize",
          name: "Summarize",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write a summary without any contract.",
          graphWorkProductRequired: false,
        },
        {
          id: "audit-evidence", qaType: "semantic",
          name: "Audit evidence",
          agentId: qaAgentId,
          dependencies: ["collect-evidence"],
          description: "Validate the dependency workProduct.",
          graphWorkProductRequired: false,
          contract: {
            postconditions: ["Verdict submitted via /workflow/verdict"],
          },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-26",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const producerStepRun = stepRuns.find((row) => row.stepId === "collect-evidence")!;
    const producerIssueId = producerStepRun.issueId!;
    const summarizeStepRun = stepRuns.find((row) => row.stepId === "summarize")!;

    // [B안] producer step 계약이 발주 이슈 지침에 구조 섹션으로 주입된다.
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    const producerDescription = producerIssue.description ?? "";
    expect(producerDescription).toContain("Step contract:");
    expect(producerDescription).toContain("Preconditions (verify before starting; report blocked if unmet):");
    expect(producerDescription).toContain("Data source brief is registered");
    expect(producerDescription).toContain("Postconditions (must hold when you mark this step complete):");
    expect(producerDescription).toContain("evidence.json exists in the step output directory");
    expect(producerDescription).toContain("Undefined behaviors (outcome is NOT guaranteed; stop and report instead of guessing):");
    expect(producerDescription).toContain("If the data source is unreachable, evidence content is undefined — report blocked instead of guessing");

    // 계약 없는 스텝은 섹션 자체가 없어야 한다.
    const [summarizeIssue] = await db.select().from(issues).where(eq(issues.id, summarizeStepRun.issueId!));
    expect((summarizeIssue.description ?? "")).not.toContain("Step contract:");

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      },
    });
    await issueService(db).update(producerIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, producerIssueId);

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qaStepRun = stepRuns.find((row) => row.stepId === "audit-evidence")!;
    expect(qaStepRun.issueId).toBeTruthy();

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qaStepRun.issueId!));
    const qaDescription = qaIssue.description ?? "";
    // QA 스텝 자체 계약도 이슈 지침에 주입된다.
    expect(qaDescription).toContain("Step contract:");
    expect(qaDescription).toContain("Verdict submitted via /workflow/verdict");

    // 의존 producer 스텝의 계약(사후조건·미정의동작)이 QA 루브릭에 전달된다.
    const rubricPath = qaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    expect(fs.existsSync(rubricPath!)).toBe(true);
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Dependency step contracts");
    expect(rubric).toContain("collect-evidence");
    expect(rubric).toContain("evidence.json exists in the step output directory");
    expect(rubric).toContain("If the data source is unreachable, evidence content is undefined — report blocked instead of guessing");
  });

  it("creates distinct issues for two QA steps with the same title in one run (same-title step collision regression)", async () => {
    // Regression for the B incident: two QA steps named "[QA] Verify mission result"
    // in the SAME run previously shared one issue because createWorkflowStepIssue
    // reused by title. That collapsed verdict/validation binding (RES-2759).
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-same-title-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-same-title-qa" });

    await db.insert(companies).values({
      id: companyId,
      name: "Same Title QA",
      issuePrefix: `ST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA Agent",
      role: "validator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Same-title QA mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "same-title qa steps",
      stepsJson: [
        {
          id: "qa-6-ac16fc87c5",
          name: "[QA] Verify mission result",
          agentId,
          dependencies: [],
          description: "First QA step verifying mission result.",
        },
        {
          id: "qa-9dde506b6c",
          name: "[QA] Verify mission result",
          agentId,
          dependencies: [],
          description: "Second QA step verifying mission result (synthetic).",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-08-06",
    });

    await executeWorkflowRun(db, runId);

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qa6 = stepRuns.find((row) => row.stepId === "qa-6-ac16fc87c5");
    const qa9 = stepRuns.find((row) => row.stepId === "qa-9dde506b6c");
    expect(qa6?.issueId).toBeTruthy();
    expect(qa9?.issueId).toBeTruthy();
    // Distinct issues — the core regression.
    expect(qa6!.issueId).not.toEqual(qa9!.issueId);

    const issuesForRun = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.originRunId, runId),
        eq(issues.originKind, "workflow_execution"),
      ));
    expect(issuesForRun.filter((row) => row.title === "[QA] Verify mission result").length).toBe(2);
  });

  it("injects a delivery verification gate for manual-onboarding publish workflows and blocks completion until readback passes", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const publisherAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-delivery-gate-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-delivery-gate" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Delivery Gate",
      issuePrefix: `DG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "HTML Producer",
        role: "builder",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: publisherAgentId,
        companyId,
        name: "Manual Publisher",
        role: "publisher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: producerAgentId,
      title: "Publish Feynman manual",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "manual-onboarding publish workflow",
      stepsJson: [
        {
          id: "build-html",
          name: "Build HTML",
          agentId: producerAgentId,
          dependencies: [],
          description: "Build the manual HTML.",
          graphWorkProductRequired: true,
        },
        {
          id: "publish-manual-onboarding", deliveryVerification: "required",
          name: "Publish to manual-onboarding R2",
          agentId: publisherAgentId,
          dependencies: ["build-html"],
          description: "Upload to the manual-onboarding public hub.",
          graphWorkProductRequired: false,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-28",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.map((row) => row.stepId).sort()).toEqual([
      "build-html",
      "delivery-verification-gate",
      "publish-manual-onboarding",
    ]);
    expect(stepRuns.find((row) => row.stepId === "delivery-verification-gate")?.issueId).toBeNull();

    const buildIssueId = stepRuns.find((row) => row.stepId === "build-html")!.issueId!;
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: buildIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/build-html/index.html`,
      title: "index.html",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/build-html/index.html`,
      },
    });
    await issueService(db).update(buildIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, buildIssueId);

    stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const publishIssueId = stepRuns.find((row) => row.stepId === "publish-manual-onboarding")!.issueId!;
    expect(publishIssueId).toEqual(expect.any(String));
    expect(stepRuns.find((row) => row.stepId === "delivery-verification-gate")?.issueId).toBeNull();

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: publishIssueId,
      type: "url",
      provider: "manual-onboarding",
      externalId: "manual-onboarding/concepts/feynman-technique-v1/index.html",
      url: "https://manual-onboarding.pages.dev/onboarding/concepts/feynman-technique-v1/index.html",
      title: "Published manual URL",
      status: "active",
      isPrimary: true,
      metadata: { section: "concepts" },
    });
    await issueService(db).update(publishIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, publishIssueId);

    stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const deliveryRun = stepRuns.find((row) => row.stepId === "delivery-verification-gate")!;
    expect(deliveryRun.issueId).toEqual(expect.any(String));
    const [runBeforeDeliveryQa] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(runBeforeDeliveryQa?.status).toBe("running");

    const [deliveryIssue] = await db.select().from(issues).where(eq(issues.id, deliveryRun.issueId!));
    const deliveryDescription = deliveryIssue?.description ?? "";
    expect(deliveryDescription).toContain("QA grading rubric:");
    const rubricPath = deliveryDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    const deliveryRubric = fs.readFileSync(rubricPath!, "utf8");
    expect(deliveryRubric).toContain("Verification Before Completion");
    expect(deliveryRubric).toContain("fresh evidence");
    expect(deliveryRubric).toContain("Delivery Verification");
    expect(deliveryRubric).toContain("final consumer path");
    expect(deliveryRubric).toContain("HTTP 200");
    expect(deliveryRubric).toContain("Identify every completion claim");

    await recordWorkflowVerdictForIssue(deliveryRun.issueId!, "pass", "2026-06-28T00:40:00.000Z");
    await issueService(db).update(deliveryRun.issueId!, { status: "done" });
    await syncWorkflowRunForIssue(db, deliveryRun.issueId!);
    const [completedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(completedRun?.status).toBe("completed");
  });

  it("strengthens an existing public readback QA step without appending a duplicate delivery gate", async () => {
    const companyId = randomUUID();
    const publisherAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-delivery-readback-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-existing-readback" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Existing Delivery Readback",
      issuePrefix: `DR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: publisherAgentId,
      companyId,
      name: "Manual Publisher",
      role: "publisher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: publisherAgentId,
      title: "Publish with existing smoke QA",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "manual-onboarding publish with smoke QA",
      stepsJson: [
        {
          id: "publish-manual-onboarding", deliveryVerification: "required",
          name: "Publish to manual-onboarding R2",
          agentId: publisherAgentId,
          dependencies: [],
          description: "Upload to the manual-onboarding public hub.",
        },
        {
          id: "publish-smoke-qa", qaType: "delivery",
          name: "[QA] 게시 smoke QA: R2 HTTP 200 + hub index 갱신 확인",
          agentId: publisherAgentId,
          dependencies: ["publish-manual-onboarding"],
          description: "Confirm the published item is visible.",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-28",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.map((row) => row.stepId).sort()).toEqual([
      "publish-manual-onboarding",
      "publish-smoke-qa",
    ]);
    expect(stepRuns.some((row) => row.stepId === "delivery-verification-gate")).toBe(false);

    const publishIssueId = stepRuns.find((row) => row.stepId === "publish-manual-onboarding")!.issueId!;
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: publishIssueId,
      type: "url",
      provider: "manual-onboarding",
      externalId: "manual-onboarding/concepts/feynman-technique-v1/index.html",
      url: "https://manual-onboarding.pages.dev/onboarding/concepts/feynman-technique-v1/index.html",
      title: "Published manual URL",
      status: "active",
      isPrimary: true,
      metadata: { section: "concepts" },
    });
    await issueService(db).update(publishIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, publishIssueId);

    stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.some((row) => row.stepId === "delivery-verification-gate")).toBe(false);
    const smokeQaRun = stepRuns.find((row) => row.stepId === "publish-smoke-qa")!;
    expect(smokeQaRun.issueId).toEqual(expect.any(String));

    const [smokeQaIssue] = await db.select().from(issues).where(eq(issues.id, smokeQaRun.issueId!));
    const smokeQaDescription = smokeQaIssue?.description ?? "";
    const rubricPath = smokeQaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Confirm the published item is visible.");
    expect(rubric).toContain("Verification Before Completion");
    expect(rubric).toContain("fresh evidence");
    expect(rubric).toContain("Delivery Verification");
    expect(rubric).toContain("final consumer path");
    expect(rubric).toContain("HTTP 200");
  });

  it("copies execution controls into workflow step run metadata when launching a step", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-execution-controls" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Execution Controls",
      issuePrefix: `EC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Execution Controls Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Report",
          agentId,
          dependencies: [],
          graphConcurrencyKey: "market-report",
          graphConcurrencyLimit: 2,
          graphPriority: "high",
          graphCacheEnabled: true,
          graphCacheTtlSeconds: 600,
          graphDeleteAfterUse: true,
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRun?.metadata).toEqual({
      executionControls: {
        concurrencyKey: "market-report",
        concurrencyLimit: 2,
        priority: "high",
        cacheEnabled: true,
        cacheTtlSeconds: 600,
        deleteAfterUse: true,
      },
      graphWorkProductRequired: false,
    });
  });

  it("wakes an existing todo workflow step issue when a run is resumed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "deliver-report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-resume" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Resume Workflow",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Resume Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Resume Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Resume Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Deliver report",
          agentId,
          dependencies: [],
          description: "Deliver the report",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });
    const existingIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      status: "todo",
      title: "Resume Workflow: Deliver report",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId,
      issueId: existingIssue.id,
      status: "pending",
    });

    const result = await syncWorkflowRunState(db, runId, "workflow_execution", { requireRunning: true });

    expect(result.status).toBe("running");
    const issueRows = await db.select().from(issues).where(eq(issues.originRunId, runId));
    expect(issueRows.map((issue) => issue.id)).toEqual([existingIssue.id]);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: existingIssue.id,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId,
      }),
      requestedByActorType: "system",
      requestedByActorId: `workflow:${workflowId}`,
      contextSnapshot: expect.objectContaining({
        issueId: existingIssue.id,
        taskId: existingIssue.id,
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        workflowStepId: stepId,
        stepId,
        source: "workflow.resume",
        wakeReason: "workflow_step_runnable",
      }),
    }));
  });

  it("restores a released workflow step issue assignee before waking it on resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "qa-report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-restored-assignee" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Released Workflow",
      issuePrefix: `RL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA Agent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Released QA Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Released QA Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "QA report",
          agentId,
          dependencies: [],
          description: "Validate the report",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });
    const existingIssue = await issueService(db).create(companyId, {
      assigneeAgentId: null,
      missionId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      status: "todo",
      title: "Released QA Workflow: QA report",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId,
      issueId: existingIssue.id,
      status: "pending",
    });

    const result = await syncWorkflowRunState(db, runId, "workflow_execution", { requireRunning: true });

    expect(result.status).toBe("running");
    const [restoredIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, existingIssue.id));
    expect(restoredIssue?.assigneeAgentId).toBe(agentId);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: existingIssue.id,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId,
      }),
    }));
  });

  it("blocks downstream tool steps when a validator issue is done with REQUEST_CHANGES", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const validatorStepRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Gate",
      issuePrefix: `VG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact", qaType: "semantic",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorStepRunId,
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);
    await recordWorkflowVerdictForIssue(validatorIssueId, "request_changes", "2026-06-14T06:10:00.000Z");

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")).toMatchObject({
      status: "failed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "pending",
      issueId: null,
    });
  });

  it("queues a blocked validator issue when an upstream dependency completes after REQUEST_CHANGES", async () => {
    const companyId = randomUUID();
    const synthAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const synthIssueId = randomUUID();
    const validatorIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-validator-recheck" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recheck",
      issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: synthAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Daily AI news validator recheck",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "synthesize-ai-news-note",
          name: "Synthesize TechCrunch AI note draft",
          agentId: synthAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: ["synthesize-ai-news-note"],
        },
        {
          id: "lead-ai-news-approval",
          name: "Lead approval for TechCrunch AI note",
          agentId: ownerAgentId,
          dependencies: ["validate-ai-news-note"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-18T05:06:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: synthIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Synthesize TechCrunch AI note draft",
        status: "done",
        assigneeAgentId: synthAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
        status: "blocked",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
      },
    ]);
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "synthesize-ai-news-note",
        issueId: synthIssueId,
        status: "completed",
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
        completedAt: new Date("2026-06-18T05:37:09.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "lead-ai-news-approval",
        issueId: null,
        status: "pending",
      },
    ]);
    await recordWorkflowVerdictForIssue(
      validatorIssueId,
      "request_changes",
      "2026-06-18T05:37:09.000Z",
      "REQUEST_CHANGES: Three source-bound fidelity fixes are required on the synthesis issue.",
    );

    const result = await syncWorkflowRunForIssue(db, synthIssueId);

    expect(result?.status).toBe("running");
    const [validatorIssue] = await db.select().from(issues).where(eq(issues.id, validatorIssueId));
    expect(validatorIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: validatorAgentId,
    });
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")).toMatchObject({
      status: "failed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "lead-ai-news-approval")).toMatchObject({
      status: "pending",
      issueId: null,
    });
    expect(heartbeatWakeup).toHaveBeenCalledWith(validatorAgentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: validatorIssueId,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId: "validate-ai-news-note",
        workflowStepRunId: expect.any(String),
      }),
    }));
  });

  it("[structured authority] a heartbeat PASS in stdout and a REQUEST_CHANGES comment do not record a verdict event or drive completion", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const passRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recovery",
      issuePrefix: `VR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:05:00.000Z"),
      completedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier validation failed.",
    });
    await db.insert(heartbeatRuns).values({
      id: passRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        result: "## Report Validator Verdict: **PASS**\n\nBoth requested fixes are verified.",
      },
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      finishedAt: new Date("2026-06-14T06:12:00.000Z"),
      createdAt: new Date("2026-06-14T06:11:00.000Z"),
      updatedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a REQUEST_CHANGES comment and a heartbeat resultJson.stdout PASS are not verdict
    //   authority — no structured workflow_validation_verdict event is recorded, so no downstream
    //   completion is driven by comment/stdout.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  it("[structured authority] a REQUEST_CHANGES comment before the execution window does not record a verdict event (no stdout/comment authority)", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const passRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Requeued Recovery",
      issuePrefix: `VQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news requeued recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      completedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier execution failed before requeue.",
    });
    await db.insert(heartbeatRuns).values({
      id: passRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        result: "## Report Validator Verdict: **PASS**\n\nThe current execution passes validation.",
      },
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      finishedAt: new Date("2026-06-14T06:12:00.000Z"),
      createdAt: new Date("2026-06-14T06:11:00.000Z"),
      updatedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:11:00.000Z"),
        completedAt: new Date("2026-06-14T06:12:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: comments and heartbeat stdout are not verdict authority — no event recorded, no completion.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  // stdout fixtures remain only to verify that natural-language output is not workflow authority.
  function buildCodexStdout(lines: unknown[]): string {
    return lines.map((line) => JSON.stringify(line)).join("\n");
  }

  it("[structured authority] a REQUEST_CHANGES verdict in heartbeat resultJson.stdout does not record a verdict event or fail the validator", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Validation Gate",
      issuePrefix: `CS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact", qaType: "semantic",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // This Codex JSONL output resembles a rejection but must not cause a workflow transition.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: { type: "agent_message", text: "Validating the artifact against source claims." },
          },
          {
            type: "task_complete",
            payload: {
              last_agent_message: "REQUEST_CHANGES\n- Hallucinated label remains in the PNG.\n- Coverage is incomplete; do not deliver to Telegram.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a REQUEST_CHANGES verdict carried only in heartbeat resultJson.stdout is not authority.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
  });

  it("[structured authority] a PASS verdict in heartbeat resultJson.stdout does not record a verdict event or drive downstream", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Pass Gate",
      issuePrefix: `CP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact", qaType: "semantic",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // This Codex JSONL output resembles a pass but must not cause a workflow transition.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "PASS — Both requested fixes are verified in the PNG; sources match.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a PASS verdict carried only in heartbeat resultJson.stdout is not authority — no event,
    //   no downstream completion.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  it("creates a mission for a workflow trigger without an existing mission and links run and step issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const stepId = "collect-news";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Papercompany Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tech Scout Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "tech-scout report 생성",
      steps: [
        {
          id: stepId,
          name: "Collect AI infra news",
          agentId,
          dependencies: [],
          description: "Collect source material for the daily tech scout report",
        },
      ],
    });

    const result = await workflowService.trigger(db, {
      companyId,
      workflowId: definition.id,
      triggeredBy: "manual",
      runDate: "2026-06-12",
    });

    expect(result.status).toBe("running");

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId))
      .limit(1);
    expect(run?.missionId).toBeTruthy();

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);
    expect(mission).toMatchObject({
      companyId,
      ownerAgentId: agentId,
      title: "2026-06-12 tech-scout report 생성",
      status: "active",
    });

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId))
      .limit(1);
    const [stepIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId!))
      .limit(1);
    expect(stepIssue).toMatchObject({
      missionId: run!.missionId,
      originKind: "workflow_execution",
      originId: result.runId,
      assigneeAgentId: agentId,
    });

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, run!.missionId!));
    expect(missionIssues.find((issue) => issue.originKind === "mission_main_executor_plan")).toBeUndefined();
    const oversight = missionIssues.find((issue) => issue.originKind === "mission_main_executor_oversight");
    expect(oversight).toMatchObject({
      assigneeAgentId: agentId,
      missionId: run!.missionId,
      status: "todo",
      title: "[OVERSIGHT] tech-scout report 생성",
    });

    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, run!.missionId!));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        ownerAgentId: agentId,
        revision: 1,
        status: "active",
        refs: expect.objectContaining({
          oversightIssueId: oversight!.id,
          sourceRunId: result.runId,
          workflowName: "tech-scout report 생성",
          workflowStepIds: [stepId],
        }),
      }),
    ]);
  });

  it("uses workflow/company timezone, not UTC, for scheduled runDate and mission titles", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-timezone-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "KST Workflow Company",
      issuePrefix: `KST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "KST Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-morning",
      timezone: null,
      steps: [
        {
          id: "collect-market",
          name: "Collect market",
          agentId,
          dependencies: [],
        },
      ],
    });

    const result = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-11T22:30:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(result.claimed).toBe(true);

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.run!.runId))
      .limit(1);
    expect(run?.runDate).toBe("2026-06-12");

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);

    expect(mission?.title).toBe("2026-06-12 gazua-morning");
  });

  it("does not start another scheduled run that would duplicate issues in the same active workflow mission", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-scheduled-active-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Active Scheduled Mission Company",
      issuePrefix: `ASM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-macro-sentinel",
      timezone: "Asia/Seoul",
      schedule: "0 9-15 * * 1-5",
      steps: [
        {
          id: "report",
          name: "초보자용 매크로 리포트 생성",
          agentId,
          dependencies: [],
        },
      ],
    });

    const first = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T00:00:00.000Z"),
      timezone: "Asia/Seoul",
    });
    expect(first.claimed).toBe(true);

    const second = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T01:00:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(second.claimed).toBe(false);
    expect(second.run).toBeNull();

    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, definition.id));
    expect(storedRuns).toHaveLength(1);

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, storedRuns[0]!.missionId!))
      .limit(1);
    expect(mission?.status).toBe("active");

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, mission!.id));
    expect(missionIssues.filter((issue) => issue.title === "초보자용 매크로 리포트 생성")).toHaveLength(1);
  });

  it("progresses dependent steps and completes the workflow as execution issues complete", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-2" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Progression",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Workflow Agent A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Editor",
        role: "pm",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentAId,
      title: "Workflow Mission",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Execution Workflow",
      stepsJson: [
        { id: "plan", name: "Plan", agentId: agentAId, dependencies: [], description: "Create the plan" },
        { id: "build", name: "Build", agentId: agentBId, dependencies: ["plan"], description: "Implement the plan" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");
    expect(initial.completedAt).toBeNull();
    expect(initial.stepRuns).toHaveLength(2);

    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const planStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const buildStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(planStepRun?.issueId).toBeTruthy();
    expect(buildStepRun?.issueId).toBeNull();

    const planIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, planStepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(planIssue?.missionId).toBe(missionId);

    await issueSvc.update(planIssue!.id, { status: "done" });
    const afterPlan = await syncWorkflowRunForIssue(db, planIssue!.id);
    expect(afterPlan?.status).toBe("running");
    expect(afterPlan?.completedAt).toBeNull();

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedPlan = progressedStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const progressedBuild = progressedStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(progressedPlan?.status).toBe("completed");
    expect(progressedBuild?.issueId).toBeTruthy();

    const buildIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedBuild!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(buildIssue?.description).not.toContain("Dependency workProduct hard-stop:");
    expect(buildIssue?.description).toContain(`- plan: ${planIssue?.identifier ?? planIssue!.id} (done)`);
    expect(buildIssue?.description).toContain("workProducts: none registered");

    await issueSvc.update(progressedBuild!.issueId!, { status: "done" });
    const afterBuild = await syncWorkflowRunForIssue(db, progressedBuild!.issueId!);
    expect(afterBuild?.status).toBe("completed");

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.completedAt).toBeTruthy();
  });



  it("does not inject a producer stdout ARTIFACT marker without a registered workProduct", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Single Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector", role: "engineer" },
        { id: agentBId, name: "Auditor", role: "pm" },
      ],
      steps: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "audit", name: "Audit", agentId: agentBId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/tech-scout/202606/tech_scout_20260624/evidence.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.collect!.id, artifactPath });
    await completeStepIssue(upstream.collect!.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(artifactPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });

  it("does not inject stdout or comment ARTIFACT markers for multiple dependencies", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const agentCId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Multi Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector A1", role: "engineer" },
        { id: agentBId, name: "Collector A2", role: "engineer" },
        { id: agentCId, name: "Synthesizer", role: "pm" },
      ],
      steps: [
        { id: "a1", name: "Collect A1", agentId: agentAId, dependencies: [], description: "Collect A1" },
        { id: "a2", name: "Collect A2", agentId: agentBId, dependencies: [], description: "Collect A2" },
        { id: "b", name: "Synthesize", agentId: agentCId, dependencies: ["a1", "a2"], description: "Synthesize A1+A2" },
      ],
    });
    const a1Path = "/srv/papercompany/produced_work/a1/evidence_a1.json";
    const a2Path = "/srv/papercompany/produced_work/a2/evidence_a2.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.a1!.id, artifactPath: a1Path });
    await seedArtifactComment({ companyId, agentId: agentBId, issueId: upstream.a2!.id, artifactPath: a2Path });
    await completeStepIssue(upstream.a1!.id);
    await completeStepIssue(upstream.a2!.id);

    const synthIssue = await getStepIssue(runId, "b");
    expect(synthIssue).toBeTruthy();
    const desc = synthIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(a1Path);
    expect(desc).not.toContain(a2Path);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });

  it("keeps graphWorkProductRequired producers incomplete without registered workProducts", async () => {
    const companyId = randomUUID();
    const collectorAgentId = randomUUID();
    const auditorAgentId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Required Dependency",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: collectorAgentId, name: "Collector", role: "engineer" },
        { id: auditorAgentId, name: "Auditor", role: "pm" },
      ],
      steps: [
        {
          id: "collect",
          name: "Collect",
          agentId: collectorAgentId,
          dependencies: [],
          description: "Collect evidence",
          graphWorkProductRequired: true,
        },
        { id: "audit", name: "Audit", agentId: auditorAgentId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const artifactPath = "/srv/papercompany/produced_work/collect/evidence.json";
    await seedArtifactRun({ companyId, agentId: collectorAgentId, issueId: upstream.collect!.id, artifactPath });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date("2026-06-24T06:05:00.000Z") })
      .where(eq(issues.id, upstream.collect!.id));
    await syncWorkflowRunForIssue(db, upstream.collect!.id);

    expect(await getStepIssue(runId, "audit")).toBeNull();
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("running");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "audit")).toMatchObject({
      status: "pending",
      issueId: null,
    });
    const workProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, upstream.collect!.id));
    expect(workProducts).toEqual([]);
  });

  it("treats QA gate dependencies as pass gates and forwards checked producer workProducts", async () => {
    const companyId = randomUUID();
    const collectorAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const outlineAgentId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact QA Gate Forwarding",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: collectorAgentId, name: "Collector", role: "researcher" },
        { id: validatorAgentId, name: "Validator", role: "validator" },
        { id: outlineAgentId, name: "Outline Writer", role: "editor" },
      ],
      steps: [
        {
          id: "collect",
          name: "Collect evidence",
          agentId: collectorAgentId,
          dependencies: [],
          description: "Collect evidence.",
          graphWorkProductRequired: true,
        },
        {
          id: "audit",
          name: "Audit evidence",
          agentId: validatorAgentId,
          dependencies: ["collect"],
          description: "Return PASS or REQUEST_CHANGES.",
          graphWorkProductRequired: false,
        },
        {
          id: "outline",
          name: "Draft outline",
          agentId: outlineAgentId,
          dependencies: ["audit"],
          description: "Read the collected evidence and write outline.md.",
          graphWorkProductRequired: true,
        },
      ],
    });

    const evidencePath = "/srv/papercompany/projects/research-company/produced_work/missions/run/steps/collect/evidence.json";
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: upstream.collect!.id,
      type: "file",
      provider: "local",
      externalId: evidencePath,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: { path: evidencePath },
    });
    await completeStepIssue(upstream.collect!.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    await db.insert(issueComments).values({
      companyId,
      issueId: auditIssue!.id,
      authorAgentId: validatorAgentId,
      body: "Coverage checked.\nPASS",
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
    await recordWorkflowVerdictForIssue(auditIssue!.id, "pass", "2026-06-24T06:06:00.000Z");
    await completeStepIssue(auditIssue!.id);

    const outlineIssue = await getStepIssue(runId, "outline");
    expect(outlineIssue).toBeTruthy();
    const desc = outlineIssue!.description ?? "";
    expect(desc).toContain("audit:"); // keep the gate visible in dependency inputs
    expect(desc).toContain("gate dependency passed without its own workProduct");
    expect(desc).toContain("Validated upstream workProducts:");
    expect(desc).toContain("collect: ");
    expect(desc).toContain("evidence.json [file/active]");
    expect(desc).toContain(evidencePath);
    expect(desc).not.toContain(`- audit: ${auditIssue!.identifier ?? auditIssue!.id} has no registered dependency workProduct.`);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");

    const outlineCard = await db
      .select({ cardJson: issueExecutionCards.cardJson })
      .from(issueExecutionCards)
      .where(eq(issueExecutionCards.issueId, outlineIssue!.id))
      .then((rows) => rows[0]?.cardJson ?? null);
    expect(outlineCard?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dependency_work_product",
        path: evidencePath,
      }),
    ]));
    const unrelatedIssue = await issueService(db).create(companyId, {
      title: "Unrelated workProduct source",
      description: "Outside the current workflow run.",
      status: "done",
    });
    const unrelatedProductId = randomUUID();
    const archivedProductId = randomUUID();
    const delegatedProductId = randomUUID();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "same-run-sibling",
      issueId: unrelatedIssue.id,
      status: "completed",
    });
    await db.insert(issueWorkProducts).values([
      {
        id: unrelatedProductId,
        companyId,
        issueId: unrelatedIssue.id,
        type: "file",
        provider: "local",
        title: "unrelated.md",
        status: "active",
        metadata: { path: "/srv/papercompany/projects/research-company/unrelated.md" },
      },
      {
        id: archivedProductId,
        companyId,
        issueId: upstream.collect!.id,
        type: "file",
        provider: "local",
        title: "archived.md",
        status: "archived",
        metadata: { path: "/srv/papercompany/projects/research-company/archived.md" },
      },
      {
        id: delegatedProductId,
        companyId,
        issueId: upstream.collect!.id,
        type: "file",
        provider: "delegated",
        title: "delegated.md",
        status: "active",
        metadata: { path: "/srv/papercompany/projects/other-company/delegated.md" },
      },
    ]);
    await db
      .update(issueExecutionCards)
      .set({
        cardJson: {
          ...outlineCard!,
          evidenceRefs: [
            ...outlineCard!.evidenceRefs,
            { type: "dependency_work_product", id: unrelatedProductId },
            { type: "dependency_work_product", id: archivedProductId },
            { type: "dependency_work_product", id: delegatedProductId },
          ],
        },
      })
      .where(eq(issueExecutionCards.issueId, outlineIssue!.id));
    const runtimeSearchPaths = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: outlineIssue!.id,
      workingDirectory: "/srv/papercompany/projects/research-company",
    });
    expect(runtimeSearchPaths).toMatchObject({
      version: 1,
      workingDirectory: "/srv/papercompany/projects/research-company",
      dependencyFiles: [evidencePath],
      dependencyDirectories: [
        "/srv/papercompany/projects/research-company/produced_work/missions/run/steps/collect",
      ],
    });
  });

  it("does not inject ARTIFACT markers from dependency or unrelated issue text", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Scope Guard",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector", role: "engineer" },
        { id: agentBId, name: "Auditor", role: "pm" },
      ],
      steps: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "audit", name: "Audit", agentId: agentBId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const depPath = "/srv/papercompany/produced_work/collect/evidence.json";
    const orphanPath = "/srv/papercompany/produced_work/orphan/unrelated.json";
    // The dependency description and an unrelated comment both contain non-authoritative markers.
    const collectIssue = upstream.collect!;
    await db
      .update(issues)
      .set({ description: `${collectIssue.description ?? ""}\n[ARTIFACT]: ${depPath}` })
      .where(eq(issues.id, collectIssue.id));
    // The unrelated issue remains outside the workflow dependency scope.
    const orphanIssue = await issueService(db).create(companyId, {
      title: "Unrelated orphan issue",
      description: "Not part of this workflow run",
      status: "todo",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: orphanIssue.id,
      authorAgentId: agentAId,
      body: `Some unrelated work.\n[ARTIFACT]: ${orphanPath}`,
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
    await completeStepIssue(collectIssue.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(depPath);
    expect(desc).not.toContain(orphanPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });

  it("advances dependent steps when a linked workflow step issue lost workflow origin metadata", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-originless-step" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Originless Workflow",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Originless Step Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    await executeWorkflowRun(db, runId);
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesizeStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collectStepRun?.issueId).toBeTruthy();
    expect(synthesizeStepRun?.issueId).toBeNull();

    await db
      .update(issues)
      .set({
        originKind: "manual",
        originId: null,
        originRunId: null,
      })
      .where(eq(issues.id, collectStepRun!.issueId!));

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });
    const afterCollect = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(afterCollect?.status).toBe("running");

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedCollect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const progressedSynthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(progressedCollect?.status).toBe("completed");
    expect(progressedSynthesize?.issueId).toBeTruthy();

    const createdSynthesisIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedSynthesize!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdSynthesisIssue).toMatchObject({
      title: "Synthesize",
      assigneeAgentId: agentBId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
  });

  it("automatically advances dependent steps when a workflow issue is marked done", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-advance" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Auto Advance Workflow",
      issuePrefix: `AA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentAId,
      title: "Auto advance mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Auto Advance Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    await executeWorkflowRun(db, runId);
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    expect(collectStepRun?.issueId).toBeTruthy();

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collect?.status).toBe("completed");
    expect(synthesize?.issueId).toBeTruthy();
    expect(synthesize?.status).toBe("pending");

    const [synthesisIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, synthesize!.issueId!));
    expect(synthesisIssue).toEqual(expect.objectContaining({
      title: "Synthesize",
      status: "todo",
      assigneeAgentId: agentBId,
    }));
  });

  it("rejects completing mission oversight while workflow steps remain active", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Oversight Guard Workflow",
      issuePrefix: `OG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oversight guard mission",
      status: "active",
    });
    const issueSvc = issueService(db);
    const oversight = await issueSvc.create(companyId, {
      missionId,
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Oversight guard mission",
      status: "todo",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Oversight Guard Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(workflowStepRuns).values([
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "collect",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "synthesize",
        status: "pending",
      },
    ]);

    await expect(issueSvc.update(oversight.id, { status: "done" }))
      .rejects.toThrow(/Cannot complete mission oversight/);

    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversight.id));
    expect(storedOversight?.status).toBe("todo");
  });

  it("creates unassigned issues for workflow steps without an agent", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Unassigned Workflow",
      issuePrefix: `WU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unassigned Workflow",
      stepsJson: [
        {
          id: "manual-review",
          name: "Manual review",
          agentId: "",
          dependencies: [],
          description: "Needs operator assignment later",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);
    expect(result.status).toBe("running");

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: "Manual review",
      assigneeAgentId: null,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).not.toHaveBeenCalled();
  });

  it("resolves legacy plugin workflow step agentName to the company agent assignee", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-agent-name" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Agent Name Workflow",
      issuePrefix: `WN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "terminated",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: agentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          title: "TechCrunch AI 데일리 브리핑",
          type: "agent",
          agentName: "Technology Research Agent",
          tools: ["techcrunch-ai-scan"],
          dependsOn: [],
          description: "Collect AI funding and product news.",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);
    expect(result.status).toBe("running");

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .limit(1);
    expect(stepRun).toMatchObject({
      stepId: "collect-ai-news-evidence",
      status: "pending",
    });
    expect(stepRun?.issueId).toBeTruthy();

    const [createdIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .limit(1);
    expect(createdIssue).toMatchObject({
      title: "TechCrunch AI 데일리 브리핑",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    const contract = await workflowService.getStepExecutionContractForIssue(db, createdIssue!.id);
    expect(contract).toMatchObject({
      workflowRunId: runId,
      stepId: "collect-ai-news-evidence",
      stepName: "TechCrunch AI 데일리 브리핑",
      toolNames: ["techcrunch-ai-scan"],
    });
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      reason: "issue_assigned",
    }));
  });

  it("queues issue-less tool steps and advances dependent agent steps after queued tool result", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-tool-agent" });
    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Tool Workflow",
      issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Projection Workflow",
      stepsJson: [
        {
          id: "fetch-context",
          name: "Fetch context",
          agentId: "",
          dependencies: [],
          description: "Load context through a workflow tool",
          toolNames: ["search-docs"],
          toolArgs: { query: "mission context" },
        },
        {
          id: "summarize",
          name: "Summarize",
          agentId,
          dependencies: ["fetch-context"],
          description: "Summarize the context",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);
    expect(result.status).toBe("running");

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const toolStep = stepRuns.find((stepRun) => stepRun.stepId === "fetch-context");
    const agentStep = stepRuns.find((stepRun) => stepRun.stepId === "summarize");

    expect(toolStep).toMatchObject({
      issueId: null,
      status: "running",
    });
    expect(toolStep?.startedAt).toBeTruthy();
    expect(toolStep?.completedAt).toBeNull();
    expect(agentStep?.issueId).toBeNull();
    expect(agentStep?.status).toBe("pending");
    expect(toolStep?.lastDispatchRequestId).toBeTruthy();
    expect(toolStep?.lastDispatchAcceptedAt).toBeNull();
    expect(executeToolStep).not.toHaveBeenCalled();

    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      workflowRunId: runId,
      workflowId,
      stepId: "fetch-context",
      stepRunId: toolStep!.id,
      toolName: "search-docs",
      args: { query: "mission context" },
    }));

    const afterToolResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: toolStep!.id,
      requestId: toolStep!.lastDispatchRequestId!,
      success: true,
    });
    expect(afterToolResult?.status).toBe("running");

    const updatedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const completedToolStep = updatedStepRuns.find((stepRun) => stepRun.stepId === "fetch-context");
    const launchedAgentStep = updatedStepRuns.find((stepRun) => stepRun.stepId === "summarize");
    expect(completedToolStep).toMatchObject({
      issueId: null,
      status: "completed",
    });
    expect(completedToolStep?.completedAt).toBeTruthy();
    expect(launchedAgentStep?.issueId).toBeTruthy();
    expect(launchedAgentStep?.status).toBe("pending");

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: "Summarize",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
  });

  it("hands an issue-less HTTP tool artifact to its dependent agent step", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";
    const artifactPath = `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/normalize/normalized_news_ledger.json`;
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-tool-artifact" });
    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "HTTP Tool Artifact Handoff Company",
      issuePrefix: `HA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      workProductRoot,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Evidence Analyst",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "HTTP tool artifact handoff",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "http-tool-artifact-handoff",
      stepsJson: [
        {
          id: "normalize",
          name: "Normalize source data",
          type: "tool",
          agentId: "",
          dependencies: [],
          toolNames: ["normalize-data"],
        },
        {
          id: "analyze",
          name: "Analyze normalized data",
          type: "agent",
          agentId,
          dependencies: ["normalize"],
          graphWorkProductRequired: true,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    await executeWorkflowRun(db, runId);
    await processQueuedWorkflowToolStepRuns(db);
    const [toolStep] = await db
      .select()
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.stepId, "normalize"),
      ));
    expect(toolStep?.lastDispatchRequestId).toBeTruthy();

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: toolStep!.id,
      requestId: toolStep!.lastDispatchRequestId!,
      workflowRunId: runId,
      stepId: "normalize",
      toolName: "normalize-data",
      success: true,
      data: { rawPath: artifactPath },
    });

    const [analyzeStep] = await db
      .select()
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.stepId, "analyze"),
      ));
    expect(analyzeStep?.issueId).toBeTruthy();
    const [analyzeIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, analyzeStep!.issueId!));
    expect(analyzeIssue?.description).toContain("Dependency tool artifacts:");
    expect(analyzeIssue?.description).toContain(artifactPath);

    const [card] = await db
      .select({ cardJson: issueExecutionCards.cardJson })
      .from(issueExecutionCards)
      .where(eq(issueExecutionCards.issueId, analyzeStep!.issueId!));
    expect(card?.cardJson.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dependency_tool_artifact",
        path: artifactPath,
      }),
    ]));

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: analyzeStep!.issueId!,
      workingDirectory: "/srv/papercompany/projects/research-company",
    });
    expect(permissions?.dependencyFiles).toEqual([artifactPath]);
  });

  it("records issue-less tool dispatch failures on the step run", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    setWorkflowToolStepExecutor(vi.fn().mockRejectedValue(new Error("Tool Registry plugin is not installed.")));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Tool Failure Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Failure Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          dependencies: [],
          toolNames: ["collect-data"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    const queuedBeforeDispatch = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(queuedBeforeDispatch[0]).toMatchObject({
      stepId: "collect",
      status: "running",
      lastDispatchErrorSummary: null,
    });

    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 1 });

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRun).toMatchObject({
      stepId: "collect",
      status: "failed",
      lastDispatchErrorSummary: "Tool Registry plugin is not installed.",
    });
    expect(stepRun?.metadata).toEqual(expect.objectContaining({
      toolInvocation: expect.objectContaining({
        toolName: "collect-data",
        dispatchError: "Tool Registry plugin is not installed.",
      }),
    }));
  });

  registerWorkflowDagToolArgsAndCacheCases(() => db);

  registerWorkflowDagToolConcurrencyAndRetentionCases(() => db);

  registerWorkflowDagAllToolWorkflowCases(() => db);

  registerWorkflowDagToolRegistryEventCases(() => db);

  registerWorkflowDagCrossCompanyDelegationCases(() => db, heartbeatWakeup);

  registerWorkflowDagPrerequisiteFailureCases(() => db, heartbeatWakeup);

  registerWorkflowDagFailureGateCases(() => db, heartbeatWakeup);

  registerWorkflowDagMixedControlFlowCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagStaleDispatchCases(() => db);

  registerWorkflowDagMissionSupervisionCases(() => db, heartbeatWakeup);

  registerWorkflowDagOwnerRecommendationCases(() => db);

  registerWorkflowDagPlanAndCancelCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagBackedgeVerdictCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaLoopBudgetCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaDownstreamCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaLoopTerminalCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);
});
