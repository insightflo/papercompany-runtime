// [purpose] run-terminal-boundary v1 호출부 연결 통합 테스트 — dag-engine 종결 경계 우회/유예,
//   실패 보존 재수렴(항상 적용), stale authority 를 임베디드 PG 로 검증한다.
//   리컨사일러(stuck/deadlock)·sweep 쪽은 run-terminal-boundary-reconciler-integration.test.ts.
//   기존 테스트 파일은 수정하지 않는다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  createDb,
  instanceSettings,
  issues,
  missionAgentRuntimes,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables } from "./helpers/run-terminal-boundary-fixture.js";
import {
  seedBoundaryIntegrationRun,
  setRunTerminalBoundaryFlag,
} from "./helpers/run-terminal-boundary-integration-fixtures.js";

// vi.hoisted: ESM 임포트 해석 중 mock factory 가 실행된다. 실 wake 경로는 agent_runtime_state
// FK 정리 실패를 유발하므로 dag-engine 테스트와 동일한 주입 패턴을 쓴다.
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

import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-terminal-boundary integration tests: ${support.reason ?? "unsupported host"}`);
}

describeEP("run-terminal-boundary dag-engine wiring", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-terminal-boundary-integration-");
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

  it("flag ON: converged failed sync finalizes through the boundary with scoped stop targets", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-boundary-failed" });
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      steps: [
        { stepId: "produce", status: "failed", issueStatus: "blocked" },
        { stepId: "post", status: "completed", dependencies: ["produce"] },
      ],
      runtimeOnStepIssue: "produce",
    });
    // 같은 미션의 무관 런타임 — legacy 미션 전역 stop 이라면 중단될 대상(스코프 대조군).
    //   mission+agent+adapter 고유 인덱스와 current_issue FK 때문에 별도 에이전트/이슈로 시딩한다.
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId: world.companyId, name: "Unrelated Runtime Agent", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId, companyId: world.companyId, missionId: world.missionId,
      identifier: `BI-${randomUUID().slice(0, 6)}`, title: "Unrelated issue", status: "in_progress",
      originKind: "workflow_execution", originRunId: world.runId,
    });
    const unrelatedRuntimeId = randomUUID();
    await db.insert(missionAgentRuntimes).values({
      id: unrelatedRuntimeId, companyId: world.companyId, missionId: world.missionId, agentId: otherAgentId,
      adapterType: "codex_local", runtimeKey: `rt-${randomUUID().slice(0, 8)}`,
      status: "busy", queueDepth: 1, currentIssueId: unrelatedIssueId,
    });

    const result = await syncWorkflowRunState(db, world.runId);

    expect(result.status).toBe("failed");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("failed");
    const decisions = await decisionsOf(world.runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "failed",
      policyCause: "outcome_convergence",
      discoveryPath: "engine_recompute",
      origin: "dag_engine",
    });
    const runtimes = await db.select().from(missionAgentRuntimes);
    expect(runtimes.find((runtime) => runtime.id === world.runtimeId)?.status).toBe("stopped");
    expect(runtimes.find((runtime) => runtime.id === unrelatedRuntimeId)?.status).toBe("busy");
  });

  it("flag ON: open unblock channel defers finalization — run stays running, no decision, transitions still recorded", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-boundary-deferred" });
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      steps: [
        { stepId: "produce", status: "failed", issueStatus: "blocked", unblock: true },
        { stepId: "post", status: "completed", dependencies: ["produce"] },
        { stepId: "publish", status: "pending", issueStatus: "done", dependencies: ["post"] },
      ],
    });

    const result = await syncWorkflowRunState(db, world.runId);

    expect(result.status).toBe("running");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("running");
    expect(run?.completedAt).toBeNull();
    expect(await decisionsOf(world.runId)).toHaveLength(0);
    // 유예여도 스텝 상태 전이 기록은 계속된다(publish pending→completed).
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, world.runId));
    expect(events.some((event) => event.toStatus === "completed")).toBe(true);
  });

  it("failure-preserving recompute (always on): cascade-skipped steps without a failed step converge to failed", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-cascade-recompute" });
    await setRunTerminalBoundaryFlag(db, false);
    const world = await seedBoundaryIntegrationRun(db, {
      steps: [
        { stepId: "a", status: "skipped", metadata: { failureCascadeSkipped: true } },
        { stepId: "b", status: "skipped", metadata: { failureCascadeSkipped: true }, dependencies: ["a"] },
      ],
    });

    await syncWorkflowRunState(db, world.runId);

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("failed");
  });

  it("failure-preserving recompute: the cancelled branch still wins over cascade-skipped failure", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-cascade-cancelled" });
    await setRunTerminalBoundaryFlag(db, false);
    const world = await seedBoundaryIntegrationRun(db, {
      runStatus: "cancelled",
      steps: [
        { stepId: "a", status: "skipped", metadata: { failureCascadeSkipped: true } },
        { stepId: "b", status: "skipped", metadata: { failureCascadeSkipped: true }, dependencies: ["a"] },
      ],
    });

    await syncWorkflowRunState(db, world.runId);

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("cancelled");
  });

  it("stale authority: a superseded version is reported and the next normal sync finalizes cleanly", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-stale-authority" });
    await setRunTerminalBoundaryFlag(db, true);
    const world = await seedBoundaryIntegrationRun(db, {
      steps: [
        { stepId: "produce", status: "failed", issueStatus: "blocked" },
        { stepId: "post", status: "completed", dependencies: ["produce"] },
      ],
    });
    // 경합 시뮬레이션 — sync 컨텍스트 적재 전에 권한 버전이 올라간 상황을 직접 호출로 재현한다.
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, world.runId));
    const stale = await finalizeRunTerminal(db, {
      runId: world.runId,
      companyId: world.companyId,
      expectedAuthorityVersion: 0,
      decision: "failed",
      cause: { policy: "budget_hard_stop", discovery: "engine_failure", origin: "reconciler" },
      gatePolicy: "immediate",
      now: new Date(),
      stepRuns: await stepsOf(world.runId),
    });
    expect(stale.kind).toBe("stale_authority");
    expect(await decisionsOf(world.runId)).toHaveLength(0);

    const result = await syncWorkflowRunState(db, world.runId);
    expect(result.status).toBe("failed");
    const decisions = await decisionsOf(world.runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "failed", origin: "dag_engine" });
  });
});
