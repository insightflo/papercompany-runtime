// [purpose] run-terminal-boundary v1 리컨사일러 연결 통합 테스트 — stuck pass 의 유예/경계 종결,
//   deadlock pass 의 수렴/유예, 그리고 종결 부작용 인텐트의 지연 재처리(sweep)를 검증한다.
//   dag-engine 쪽은 run-terminal-boundary-integration.test.ts. 기존 테스트 파일은 수정하지 않는다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  createDb,
  heartbeatRuns,
  instanceSettings,
  missionAgentRuntimes,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables, hoursFromNow, retryMetadata } from "./helpers/run-terminal-boundary-fixture.js";
import {
  seedBoundaryIntegrationRun,
  setRunTerminalBoundaryFlag,
} from "./helpers/run-terminal-boundary-integration-fixtures.js";

// vi.hoisted: ESM 임포트 해석 중 mock factory 가 실행된다(dag-engine 테스트와 동일 주입 패턴).
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

import { reconcileDeadlockedWorkflowRuns, reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
import { executeTerminalEffectIntents, finalizeRunTerminal, processPendingTerminalEffectIntents } from "../services/workflow/run-terminal-boundary.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-terminal-boundary reconciler integration tests: ${support.reason ?? "unsupported host"}`);
}

describeEP("run-terminal-boundary reconciler wiring", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-terminal-boundary-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.delete(instanceSettings);
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const decisionsOf = async (runId: string) =>
    await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, runId));
  const stepsOf = async (runId: string) =>
    await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  const runOf = async (runId: string) =>
    await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0]);

  it("flag ON stuck pass: open unblock channel defers — pending steps untouched, run still running", async () => {
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      steps: [
        { stepId: "collect", status: "failed", issueStatus: "blocked", unblock: true },
        { stepId: "post", status: "pending", dependencies: ["collect"] },
      ],
    });

    const results = await reconcileStuckWorkflowRuns(db, 60);

    expect(results).toEqual([expect.objectContaining({ runId: world.runId, action: "deferred" })]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("running");
    expect(run?.completedAt).toBeNull();
    const steps = await stepsOf(world.runId);
    expect(steps.find((step) => step.stepId === "post")?.status).toBe("pending");
    expect(await decisionsOf(world.runId)).toHaveLength(0);
  });

  it("flag ON stuck pass: clear gate finalizes via the boundary and executes the scoped kill effect", async () => {
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      steps: [
        { stepId: "collect", status: "failed", issueStatus: "blocked" },
        { stepId: "post", status: "pending", dependencies: ["collect"] },
      ],
      runtimeOnStepIssue: "collect",
    });

    const results = await reconcileStuckWorkflowRuns(db, 60);

    expect(results).toEqual([
      expect.objectContaining({ runId: world.runId, action: "recovered", reason: expect.stringContaining("terminal decision") }),
    ]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("failed");
    const decisions = await decisionsOf(world.runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "failed",
      policyCause: "recovery_deadline_hard",
      discoveryPath: "stuck_diagnostic",
      origin: "reconciler",
    });
    const intents = await db.select().from(workflowTerminalEffectIntents);
    expect(intents.map((intent) => intent.effectKind)).toContain("kill_runtime");
    expect(intents.every((intent) => intent.status === "completed")).toBe(true);
    const [runtime] = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.id, world.runtimeId!));
    expect(runtime?.status).toBe("stopped");
  });

  it("flag OFF stuck pass: the legacy direct UPDATE stays decision-free", async () => {
    await setRunTerminalBoundaryFlag(db, false);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      steps: [
        { stepId: "collect", status: "failed", issueStatus: "blocked" },
        { stepId: "post", status: "pending", dependencies: ["collect"] },
      ],
    });

    const results = await reconcileStuckWorkflowRuns(db, 60);

    expect(results).toEqual([
      expect.objectContaining({ runId: world.runId, action: "recovered", reason: "Marked stuck run as failed" }),
    ]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("failed");
    expect(await decisionsOf(world.runId)).toHaveLength(0);
    const steps = await stepsOf(world.runId);
    expect((steps.find((step) => step.stepId === "post")?.metadata as { failureCascadeSkipped?: boolean })?.failureCascadeSkipped).toBe(true);
  });

  it("flag ON deadlock pass: convergence finalizes via the boundary", async () => {
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 6 * 60_000),
      steps: [
        { stepId: "collect", status: "failed" },
        { stepId: "synthesize", status: "pending", dependencies: ["collect"] },
      ],
    });

    const results = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(results).toEqual([expect.objectContaining({ runId: world.runId, action: "recovered" })]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("failed");
    const decisions = await decisionsOf(world.runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "failed",
      policyCause: "recovery_deadline_hard",
      discoveryPath: "deadlock_detection",
      origin: "deadlock_reconciler",
    });
    const steps = await stepsOf(world.runId);
    const synthesize = steps.find((step) => step.stepId === "synthesize")!;
    expect(synthesize.status).toBe("skipped");
    expect((synthesize.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBe(true);
  });

  it("flag ON deadlock pass: open retry channel defers finalization and leaves the run running", async () => {
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 6 * 60_000),
      steps: [
        // 게이트 채널 b 평가는 유효 step 이슈가 있을 때만 도달한다 — 실패 스텝에 실행 이슈를 붙인다.
        { stepId: "collect", status: "failed", issueStatus: "blocked", metadata: retryMetadata("waiting", 1, 3, hoursFromNow(1)) },
        { stepId: "synthesize", status: "pending", dependencies: ["collect"] },
      ],
    });

    const results = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(results).toEqual([
      expect.objectContaining({
        runId: world.runId,
        action: "skipped",
        reason: expect.stringContaining("Deadlock finalization deferred"),
      }),
    ]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("running");
  });

  it("flag OFF deadlock pass: legacy convergence stays decision-free", async () => {
    await setRunTerminalBoundaryFlag(db, false);
    const world = await seedBoundaryIntegrationRun(db, {
      startedAt: new Date(Date.now() - 6 * 60_000),
      steps: [
        { stepId: "collect", status: "failed" },
        { stepId: "synthesize", status: "pending", dependencies: ["collect"] },
      ],
    });

    const results = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(results).toEqual([
      expect.objectContaining({
        runId: world.runId,
        action: "recovered",
        reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
      }),
    ]);
    const run = await runOf(world.runId);
    expect(run?.status).toBe("failed");
    expect(await decisionsOf(world.runId)).toHaveLength(0);
  });

  it("sweep: an intent on an already-settled heartbeat stays pending, increments attempts, then exhausts to failed", async () => {
    const world = await seedBoundaryIntegrationRun(db, {
      steps: [{ stepId: "only", status: "completed", issueStatus: "done" }],
    });
    const heartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatId, companyId: world.companyId, agentId: world.agentId,
      issueId: world.issueIdsByStep["only"]!, status: "queued", invocationSource: "assignment",
    });
    // completed 결정은 게이트 평가 없이 캡처한다 — 활성 heartbeat 가 cancel 인텐트로 포착된다.
    const boundary = await finalizeRunTerminal(db, {
      runId: world.runId,
      companyId: world.companyId,
      expectedAuthorityVersion: 0,
      decision: "completed",
      cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
      gatePolicy: "immediate",
      now: new Date(),
      stepRuns: [{
        id: world.stepRunIdsByStep["only"]!, stepId: "only",
        issueId: world.issueIdsByStep["only"]!, status: "completed", metadata: {},
      }],
    });
    if (boundary.kind !== "finalized") throw new Error(`expected finalized, got ${boundary.kind}`);
    // 실행 전에 대상을 선점 정산 — cancel 효과는 "already settled" 로 실패해 pending 이 유지된다.
    await db.update(heartbeatRuns).set({
      status: "completed", terminalOutcome: "succeeded", finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, heartbeatId));
    const immediate = await executeTerminalEffectIntents(db, boundary.decisionId);
    expect(immediate).toMatchObject({ executed: 0, failed: 1 });

    await processPendingTerminalEffectIntents(db, { olderThanMs: 0, maxAttempts: 3 });
    const [pendingRow] = await db.select().from(workflowTerminalEffectIntents);
    expect(pendingRow?.status).toBe("pending");
    expect(pendingRow?.attemptCount).toBe(2);

    await processPendingTerminalEffectIntents(db, { olderThanMs: 0, maxAttempts: 3 });
    await processPendingTerminalEffectIntents(db, { olderThanMs: 0, maxAttempts: 3 });
    const [exhaustedRow] = await db.select().from(workflowTerminalEffectIntents);
    expect(exhaustedRow?.status).toBe("failed");
    expect(exhaustedRow?.attemptCount).toBe(3);
  });
});
