// server/src/__tests__/terminal-cleanup-finalization.integration.test.ts
//
// [계약] 미션 종료 정리(settleMissionTerminalResources)의 v1 finalization 준수 시험.
//   B1: 종료 정리가 run 을 종결하면 terminal outcome first-wins 결정 + executor owner release +
//       finalization parent 가 기록되어 recovery lane(recoverTerminalUnsettledRuns) 이 정산
//       (settled_at 기입, lifecycle 슬롯 회수)까지 도달해야 한다.
//   B2: 정리 시점에 성공 증거(완료된 workflow step run, 기록된 성공 결과, 먼저 결정된
//       terminal outcome)가 있는 run 은 cancelled 로 덮어쓰지 않고 성공이 보존된다.
//       결정 근거는 terminal_decision_source=mission_terminal_cleanup 로 남는다.
//       사후 도착한 성공 결과는 증거로 반영되되 first-wins 종결 결정을 뒤집지 않는다.
//   B4(a): running run 을 가진 미션 completed/cancelled → run 정산 도달(settled_at, 슬롯 회수).
//   B4(b): 완료된 step 을 가진 run 의 결과가 cancelled 로 덮이지 않음.
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunFinalizations,
  heartbeatRuns,
  instanceSettings,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { recoverTerminalUnsettledRuns } from "../services/heartbeat-finalization/recovery.js";
import { lifecycleActiveClause } from "../services/heartbeat-finalization/lifecycle-active.js";
import { setHeartbeatRunStatus } from "../services/heartbeat-queue-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip terminal-cleanup finalization tests: ${support.reason ?? "unsupported"}`);

interface SeededMissionRun {
  mission: typeof missions.$inferSelect;
  issue: typeof issues.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
  wakeupRequestId: string;
}

async function seedActiveMissionRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  overrides: {
    run?: Record<string, unknown>;
    issue?: Record<string, unknown>;
    mission?: Record<string, unknown>;
    stepCompleted?: boolean;
  } = {},
): Promise<SeededMissionRun> {
  const [mission] = await db.insert(missions).values({
    companyId, ownerAgentId: agentId, title: `Cleanup mission ${randomUUID()}`, status: "active",
    ...overrides.mission,
  }).returning();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  // issue(run FK) 와 run(issue FK) 이 서로를 참조하므로 두 단계로 나눠 심는다.
  const [issue] = await db.insert(issues).values({
    companyId, missionId: mission.id, title: "Cleanup issue", status: "in_progress",
    assigneeAgentId: agentId,
    ...overrides.issue,
  }).returning();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: {}, status: "claimed", runId,
  } as never);
  let workflowStepRunId: string | null = null;
  if (overrides.stepCompleted) {
    const [definition] = await db.insert(workflowDefinitions).values({
      companyId, name: `Cleanup workflow ${randomUUID()}`, stepsJson: [{ id: "step" }],
    }).returning();
    const [workflowRun] = await db.insert(workflowRuns).values({
      companyId, workflowId: definition.id, missionId: mission.id, status: "running", triggeredBy: "test",
    }).returning();
    workflowStepRunId = randomUUID();
    await db.insert(workflowStepRuns).values({
      id: workflowStepRunId, workflowRunId: workflowRun.id, stepId: "step", status: "completed",
      metadata: {}, executionGeneration: 0,
    });
  }
  await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId, issueId: issue.id, invocationSource: "assignment",
    triggerDetail: "system", status: "running", wakeupRequestId,
    workflowStepRunId, workflowExecutionGeneration: workflowStepRunId ? 0 : null,
    executionScopeKind: workflowStepRunId ? "workflow_step" : "issue_nonworkflow",
    finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
    executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
    executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    processPid: null, ...overrides.run,
  } as never);
  await db.update(issues).set({
    checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
  }).where(eq(issues.id, issue.id));
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return { mission, issue, run: run!, wakeupRequestId };
}

function cleanupInput(seed: SeededMissionRun, status: "completed" | "cancelled", now: Date) {
  return {
    companyId: seed.mission.companyId,
    missionId: seed.mission.id,
    status,
    now,
    completedAt: status === "completed" ? now : null,
    missionSnapshot: seed.mission,
    pendingMissionUpdates: { status, updatedAt: now },
  };
}

describeEP("mission terminal cleanup honors v1 finalization contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("terminal-cleanup-finalization-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CleanupCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Cleanup agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
  });
  afterAll(() => { tempDb = null; });

  const activeCount = async (targetAgentId: string) => {
    const clause = await lifecycleActiveClause(db);
    const [{ n }] = await db.select({ n: count() }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, targetAgentId), clause));
    return Number(n ?? 0);
  };

  it("B4(a) mission completed: running v1 run is terminalized with the full v1 contract and settles", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId);
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, cleanupInput(seed, "completed", now));
    expect(result.aborted).toBe(false);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.terminalOutcome).toBe("cancelled");
    expect(run?.terminalDecisionSource).toBe("mission_terminal_cleanup");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
    expect(run?.settledAt).toBeNull();
    const [parent] = await db.select().from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, seed.run.id));
    expect(parent?.terminalOutcome).toBe("cancelled");
    expect(parent?.terminalDecisionSource).toBe("mission_terminal_cleanup");
    const [wakeup] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wakeup?.status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issue.id));
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();

    // 미정산 상태에서는 슬롯을 계속 점유한다(recovery grace 경과 후 정산·회수된다).
    expect(await activeCount(agentId)).toBeGreaterThanOrEqual(1);
    const processed = await recoverTerminalUnsettledRuns(
      db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
    expect(await activeCount(agentId)).toBe(0);
  }, 20000);

  it("B4(a) mission cancelled: same v1 contract and open issues are cancelled", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId);
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, cleanupInput(seed, "cancelled", now));
    expect(result.aborted).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("cancelled");
    expect(run?.terminalOutcome).toBe("cancelled");
    expect(run?.terminalDecisionSource).toBe("mission_terminal_cleanup");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issue.id));
    expect(issue?.status).toBe("cancelled");
    const processed = await recoverTerminalUnsettledRuns(
      db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
  }, 20000);

  it("B4(b) run with a completed workflow step run keeps its success instead of being cancelled", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId, { stepCompleted: true });
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, cleanupInput(seed, "completed", now));
    expect(result.aborted).toBe(false);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.terminalOutcome).toBe("succeeded");
    expect(run?.terminalDecisionSource).toBe("mission_terminal_cleanup");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
    const [parent] = await db.select().from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, seed.run.id));
    expect(parent?.terminalOutcome).toBe("succeeded");
    const [wakeup] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wakeup?.status).toBe("completed");
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seed.run.workflowStepRunId));
    expect(stepRun?.status).toBe("completed");

    // 후처리 workflow 동기화(syncWorkflowAfterHeartbeatSettlement)는 이 시드 상태에서 예외를 던질 수 있으나
    // recovery 레인이 삼키는 기존 동작이다 — B4 의 요건은 정산 도달(settled_at) 자체다.
    await recoverTerminalUnsettledRuns(db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
  }, 20000);

  it("B2 preserves an already-decided succeeded terminal outcome (first-wins)", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId, {
      run: {
        terminalOutcome: "succeeded", terminalDecidedAt: new Date(),
        terminalDecisionSource: "heartbeat_terminal:succeeded",
      },
    });
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, cleanupInput(seed, "cancelled", now));
    expect(result.aborted).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.terminalOutcome).toBe("succeeded");
    // 먼저 결정된 근거가 보존된다 — 종료 정리가 덮어쓰지 않는다.
    expect(run?.terminalDecisionSource).toBe("heartbeat_terminal:succeeded");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
  }, 20000);

  it("B2 run with a recorded success result (resultJson, exitCode 0) is preserved as succeeded", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId, {
      run: { resultJson: { summary: "work completed" }, exitCode: 0 },
    });
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, cleanupInput(seed, "completed", now));
    expect(result.aborted).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.terminalOutcome).toBe("succeeded");
    expect(run?.terminalDecisionSource).toBe("mission_terminal_cleanup");
  }, 20000);

  it("B2 a late-arriving success result lands as evidence without flipping the first-wins cancelled outcome", async () => {
    const seed = await seedActiveMissionRun(db, companyId, agentId);
    const now = new Date();
    await runMissionTerminalCleanup(db, cleanupInput(seed, "completed", now));

    // (1) 늦은 성공 상태 기록은 run-status 펜싱에 의해 폐기된다 — 종결 결정이 뒤집히지 않는다.
    const lateStatusWrite = await setHeartbeatRunStatus(db, seed.run.id, "succeeded", {
      finishedAt: new Date(),
    }, { expectedStatuses: ["running"] });
    expect(lateStatusWrite).toBeNull();

    // (2) 실행이 끝난 뒤 도착한 실제 성공 증거는 정상 경로(backfillTerminalRunEvidence 와 같은
    //     증거 전용 기록)로 run 에 반영된다.
    await db.update(heartbeatRuns).set({
      exitCode: 0, resultJson: { summary: "late success" }, usageJson: { totalTokens: 42 },
    }).where(eq(heartbeatRuns.id, seed.run.id));

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("cancelled");
    expect(run?.terminalOutcome).toBe("cancelled");
    expect(run?.terminalDecisionSource).toBe("mission_terminal_cleanup");
    expect(run?.exitCode).toBe(0);
    expect(run?.resultJson).toEqual({ summary: "late success" });

    // (3) 늦은 증거가 붙어도 정산은 완료된다 — 좀비 슬롯이 남지 않는다.
    const processed = await recoverTerminalUnsettledRuns(
      db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
  }, 20000);
});
