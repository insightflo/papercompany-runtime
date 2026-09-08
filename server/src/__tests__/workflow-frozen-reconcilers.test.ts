import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  createDb,
  issues,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureFrozenRecoveryState } from "./helpers/workflow-frozen-recovery-state.js";

const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import {
  reconcileDeadlockedWorkflowRuns,
  reconcileRunnableWorkflowStepWakeups,
} from "../services/workflow/reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen reconcilers (captured graph governs convergence and runnable wakes)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-reconcilers-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** frozen run(past startedAt) + terminal first step + issue-linked todo pending step. Returns real agent ids for captured/live edits. */
  async function seedFrozenReconcilerFixture(input: {
    stepsJson: (ids: { capturedAgentId: string; liveAgentId: string }) => unknown[];
    executionMode?: string | null;
    pendingStepId: string;
    planCompleted?: boolean;
  }) {
    const seeded = await seedCompanyWithMission(fixture.sql, "RC" + randomUUID().slice(0, 3));
    const [liveAgent] = await db.insert(agents).values({ id: randomUUID(), companyId: seeded.companyId, name: "Live Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const ids = { capturedAgentId: seeded.agentId, liveAgentId: liveAgent!.id };
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId,
      name: "frozen-reconciler",
      stepsJson: input.stepsJson(ids),
      ...(input.executionMode !== undefined ? { executionMode: input.executionMode } : {}),
    });
    const run = await createFrozenRun(db, { workflowId, companyId: seeded.companyId, missionId: seeded.missionId });
    await markRunStatus(db, run.id, "running");
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(workflowRuns.id, run.id));
    const [issue] = await db.insert(issues).values({
      companyId: seeded.companyId,
      missionId: seeded.missionId,
      identifier: "RC-" + randomUUID().slice(0, 8),
      title: "Wake target",
      status: "todo",
      originKind: "workflow_execution",
      originRunId: run.id,
    }).returning();
    await db.insert(workflowStepRuns).values([
      input.planCompleted
        ? { workflowRunId: run.id, stepId: "plan", status: "completed", completedAt: new Date(), iterationIndex: 0 }
        : { workflowRunId: run.id, stepId: "collect", status: "failed", completedAt: new Date(), iterationIndex: 0 },
      { workflowRunId: run.id, stepId: input.pendingStepId, status: "pending", issueId: issue!.id, iterationIndex: 0 },
    ]);
    return { seeded, liveAgentId: liveAgent!.id, workflowId, runId: run.id, issueId: issue!.id };
  }

  const wakesForRun = (runId: string) =>
    heartbeatWakeup.mock.calls.filter((call) => (call[1] as { payload?: Record<string, unknown> })?.payload?.workflowRunId === runId);

  it("deadlock converges from the captured failed success-edge even when the live edge is made always-runnable", async () => {
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "collect", name: "Collect", agentId: capturedAgentId, dependencies: [] },
        { id: "synthesize", name: "Synthesize", agentId: capturedAgentId, dependencies: ["collect"] },
      ],
      pendingStepId: "synthesize",
    });
    await editLiveDefinition(db, f.workflowId, {
      stepsJson: [
        { id: "collect", name: "Collect", agentId: f.liveAgentId, dependencies: [] },
        { id: "synthesize", name: "Synthesize", agentId: f.liveAgentId, dependencies: [], conditionalDependencies: [{ stepId: "collect", when: "always" }] },
      ],
    });

    const result = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(result).toEqual([expect.objectContaining({ runId: f.runId, action: "recovered" })]);
    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    expect(runRow?.status).toBe("failed");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId));
    const synthesize = steps.find((step) => step.stepId === "synthesize")!;
    expect(synthesize.status).toBe("skipped");
    expect((synthesize.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBe(true);
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issueRow?.status).toBe("blocked");
    const stepEvents = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, f.runId), eq(workflowTransitionEvents.workflowStepRunId, synthesize.id)));
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]).toEqual(expect.objectContaining({
      eventType: "workflow_step_status_transition", fromStatus: "pending", toStatus: "skipped",
      reasonCode: "workflow_deadlock_reconciler",
      payload: { source: "workflow_deadlock_reconciler", priorStatus: "pending", transitionVersion: 1 },
    }));
    expect(wakesForRun(f.runId)).toHaveLength(0);
  });

  it("deadlock keeps a captured always-edge successor a progress candidate when the live edge was removed", async () => {
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "collect", name: "Collect", agentId: capturedAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: capturedAgentId, dependencies: [], conditionalDependencies: [{ stepId: "collect", when: "always" }] },
      ],
      pendingStepId: "rescue",
    });
    await editLiveDefinition(db, f.workflowId, {
      stepsJson: [
        { id: "collect", name: "Collect", agentId: f.liveAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: f.liveAgentId, dependencies: [] },
      ],
    });

    const result = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(result).toEqual([]);
    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    expect(runRow?.status).toBe("running");
    const rescue = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId)))
      .find((step) => step.stepId === "rescue")!;
    expect(rescue.status).toBe("pending");
  });

  it("runnable wakeups wake from the captured graph after live edge removal, with the captured step assignee", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "frozen-r1" });
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "collect", name: "Collect", agentId: capturedAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: capturedAgentId, dependencies: [], conditionalDependencies: [{ stepId: "collect", when: "always" }] },
      ],
      pendingStepId: "rescue",
    });
    await editLiveDefinition(db, f.workflowId, {
      stepsJson: [
        { id: "collect", name: "Collect", agentId: f.liveAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: f.liveAgentId, dependencies: [] },
      ],
    });

    const result = await reconcileRunnableWorkflowStepWakeups(db, 0);

    expect(result).toEqual([expect.objectContaining({
      runId: f.runId,
      action: "recovered",
      reason: expect.stringContaining("Queued missing workflow_resume wakeup"),
    })]);
    const wakes = wakesForRun(f.runId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]![0]).toBe(f.seeded.agentId);
    expect(wakes[0]![1]).toEqual(expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({ issueId: f.issueId, mutation: "workflow_resume", workflowRunId: f.runId, stepId: "rescue" }),
    }));
  });

  it("runnable wakeups do not fire when the captured graph blocks even though the live graph allows", async () => {
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "collect", name: "Collect", agentId: capturedAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: capturedAgentId, dependencies: ["collect"] },
      ],
      pendingStepId: "rescue",
    });
    await editLiveDefinition(db, f.workflowId, {
      stepsJson: [
        { id: "collect", name: "Collect", agentId: f.seeded.agentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: f.seeded.agentId, dependencies: [], conditionalDependencies: [{ stepId: "collect", when: "always" }] },
      ],
    });

    const result = await reconcileRunnableWorkflowStepWakeups(db, 0);

    expect(result).toEqual([]);
    expect(wakesForRun(f.runId)).toHaveLength(0);
  });

  it("captured dynamic_owner_plan keeps launch restriction after a live static_dag edit", async () => {
    const f = await seedFrozenReconcilerFixture({
      executionMode: "dynamic_owner_plan",
      stepsJson: ({ capturedAgentId }) => [
        { id: "plan", name: "Plan", agentId: capturedAgentId, dependencies: [] },
        { id: "execute", name: "Execute", agentId: capturedAgentId, dependencies: ["plan"] },
      ],
      pendingStepId: "execute",
      planCompleted: true,
    });
    await editLiveDefinition(db, f.workflowId, { executionMode: "static_dag", name: "live-static-now" });

    const result = await reconcileRunnableWorkflowStepWakeups(db, 0);

    expect(result).toEqual([]);
    expect(wakesForRun(f.runId)).toHaveLength(0);
  });

  it("captured static mode wakes a runnable dependency step even after a live dynamic_owner_plan rename", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "frozen-r4" });
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "plan", name: "Plan", agentId: capturedAgentId, dependencies: [] },
        { id: "execute", name: "Execute", agentId: capturedAgentId, dependencies: ["plan"] },
      ],
      pendingStepId: "execute",
      planCompleted: true,
    });
    await editLiveDefinition(db, f.workflowId, { executionMode: "dynamic_owner_plan", name: "daily-tech-ai-news" });

    const result = await reconcileRunnableWorkflowStepWakeups(db, 0);

    expect(result).toEqual([expect.objectContaining({ runId: f.runId, action: "recovered" })]);
    const wakes = wakesForRun(f.runId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]![0]).toBe(f.seeded.agentId);
    expect(wakes[0]![1]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ workflowRunId: f.runId, stepId: "execute" }),
    }));
  });

  const invalidSnapshotCases = [
    ["deadlock", "missing"], ["deadlock", "corrupt"], ["runnable", "missing"], ["runnable", "corrupt"],
  ] as const;

  it.each(invalidSnapshotCases)("%s reconciler reports action:'failed' on a %s snapshot with byte-equivalent state and zero wakes", async (name, state) => {
    const reconcile = name === "deadlock" ? reconcileDeadlockedWorkflowRuns : reconcileRunnableWorkflowStepWakeups;
    const f = await seedFrozenReconcilerFixture({
      stepsJson: ({ capturedAgentId }) => [
        { id: "collect", name: "Collect", agentId: capturedAgentId, dependencies: [] },
        { id: "rescue", name: "Rescue", agentId: capturedAgentId, dependencies: [], conditionalDependencies: [{ stepId: "collect", when: "always" }] },
      ],
      pendingStepId: "rescue",
    });
    if (state === "missing") {
      await db.delete(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, f.runId));
    } else {
      await corruptSnapshotSteps(fixture.sql, f.runId);
    }
    const before = await captureFrozenRecoveryState(db, f.runId);

    const result = await reconcile(db, 0);

    expect(result).toEqual([expect.objectContaining({
      runId: f.runId,
      action: "failed",
      reason: expect.stringContaining("historical_definition_unproven"),
    })]);
    expect(await captureFrozenRecoveryState(db, f.runId)).toEqual(before);
    expect(wakesForRun(f.runId)).toHaveLength(0);
  });
});
