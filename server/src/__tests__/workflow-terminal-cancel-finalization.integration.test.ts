// server/src/__tests__/workflow-terminal-cancel-finalization.integration.test.ts
//
// [계약] 워크플로 종결 결정의 cancel_heartbeat_run 효과(run-terminal-effect-executor)가
// v1 finalization 계약을 준수하는지의 시험(#679 미션 종료 정리와 대칭 — 2026-11-08 bbe15a31 좀비).
//   B1: 종결 결정 후 잔여 run 취소가 raw UPDATE 로 v1 초크포인트를 우회하지 않는다.
//       terminal outcome first-wins 결정 + finalization parent + executor owner release 가
//       기록되어 recovery lane(recoverTerminalUnsettledRuns)이 정산(settled_at, 슬롯 회수)까지 도달.
//   B2: 취소 시점에 성공 증거(완료된 workflow step run, 기록된 성공 결과, 먼저 결정된
//       terminal outcome)가 있는 run 은 cancelled 로 덮지 않고 성공이 보존된다.
//       결정 근거는 terminal_decision_source=workflow_terminal_cancel 로 남는다.
//   레거시: flag OFF 에서는 기존 취소와 바이트 동일(증거 무시·finalization 기록 없음).
//   멱등: 이미 종결된 run 에 대한 인텐트는 실패로 남아 재처리 대상이 된다(기존 계약 보존).
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
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeTerminalEffectIntents } from "../services/workflow/run-terminal-effect-executor.js";
import { recoverTerminalUnsettledRuns } from "../services/heartbeat-finalization/recovery.js";
import { lifecycleActiveClause } from "../services/heartbeat-finalization/lifecycle-active.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip workflow-terminal-cancel finalization tests: ${support.reason ?? "unsupported"}`);

interface SeededCancelTarget {
  run: typeof heartbeatRuns.$inferSelect;
  wakeupRequestId: string;
  issue: typeof issues.$inferSelect;
  decisionId: string;
  intentId: string;
}

async function seedWorkflowCancelTarget(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  overrides: {
    run?: Record<string, unknown>;
    stepCompleted?: boolean;
  } = {},
): Promise<SeededCancelTarget> {
  const [definition] = await db.insert(workflowDefinitions).values({
    companyId, name: `Cancel workflow ${randomUUID()}`, stepsJson: [{ id: "step" }],
  }).returning();
  const [workflowRun] = await db.insert(workflowRuns).values({
    companyId, workflowId: definition.id, status: "running", triggeredBy: "test",
  }).returning();
  let workflowStepRunId: string | null = null;
  if (overrides.stepCompleted !== undefined) {
    workflowStepRunId = randomUUID();
    await db.insert(workflowStepRuns).values({
      id: workflowStepRunId, workflowRunId: workflowRun.id, stepId: "step",
      status: overrides.stepCompleted ? "completed" : "running",
      metadata: {}, executionGeneration: 0,
    });
  }
  const [issue] = await db.insert(issues).values({
    companyId, missionId: null, title: "Cancel effect issue", status: "in_progress",
    assigneeAgentId: agentId,
  }).returning();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: {}, status: "claimed", runId,
  } as never);
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
  const [decision] = await db.insert(workflowTerminalDecisions).values({
    companyId, workflowRunId: workflowRun.id, decidedAuthorityVersion: 1,
    decision: "completed", policyCause: "outcome_convergence", discoveryPath: "convergence_check",
    origin: "dag_engine",
    capturedStopTargets: { runtimeIds: [], heartbeatRunIds: [runId], supersededUnblockIssueIds: [] },
  }).returning();
  const [intent] = await db.insert(workflowTerminalEffectIntents).values({
    companyId, terminalDecisionId: decision.id, effectKind: "cancel_heartbeat_run",
    targetId: runId, payload: {},
  }).returning();
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return { run: run!, wakeupRequestId, issue, decisionId: decision.id, intentId: intent.id };
}

describeEP("workflow terminal cancel effect honors v1 finalization contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workflow-terminal-cancel-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CancelCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Cancel agent", status: "active",
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

  it("B1 running v1 run: cancel effect records first-wins outcome + parent + release, then settles", async () => {
    const seed = await seedWorkflowCancelTarget(db, companyId, agentId);
    const now = new Date();
    const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
    expect(result).toEqual({ executed: 1, failed: 0 });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.error).toContain("Cancelled because workflow run reached terminal decision");
    expect(run?.terminalOutcome).toBe("cancelled");
    expect(run?.terminalDecisionSource).toBe("workflow_terminal_cancel");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
    expect(run?.settledAt).toBeNull();
    const [parent] = await db.select().from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, seed.run.id));
    expect(parent?.terminalOutcome).toBe("cancelled");
    expect(parent?.terminalDecisionSource).toBe("workflow_terminal_cancel");
    const [wakeup] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    expect(wakeup?.status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issue.id));
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
    const [intent] = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.id, seed.intentId));
    expect(intent?.status).toBe("completed");

    // 미정산 상태에서는 슬롯을 계속 점유한다(recovery grace 경과 후 정산·회수된다).
    expect(await activeCount(agentId)).toBeGreaterThanOrEqual(1);
    const processed = await recoverTerminalUnsettledRuns(
      db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
    expect(await activeCount(agentId)).toBe(0);
  }, 20000);

  it("B2 run with a completed workflow step run keeps its success instead of being cancelled", async () => {
    const seed = await seedWorkflowCancelTarget(db, companyId, agentId, { stepCompleted: true });
    const now = new Date();
    const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
    expect(result).toEqual({ executed: 1, failed: 0 });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(run?.terminalOutcome).toBe("succeeded");
    expect(run?.terminalDecisionSource).toBe("workflow_terminal_cancel");
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

    // 후처리 workflow 동기화는 이 시드 상태에서 예외를 던질 수 있으나 recovery 레인이 삼키는
    // 기존 동작이다 — 요건은 정산 도달(settled_at) 자체다.
    await recoverTerminalUnsettledRuns(db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(settled?.settledAt).not.toBeNull();
  }, 20000);

  it("B2 run with a recorded success result (resultJson, exitCode 0) is preserved as succeeded", async () => {
    const seed = await seedWorkflowCancelTarget(db, companyId, agentId, {
      run: { resultJson: { summary: "work completed" }, exitCode: 0 },
    });
    const now = new Date();
    const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
    expect(result).toEqual({ executed: 1, failed: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.terminalOutcome).toBe("succeeded");
    expect(run?.terminalDecisionSource).toBe("workflow_terminal_cancel");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
  }, 20000);

  it("B2 preserves an already-decided succeeded terminal outcome (first-wins)", async () => {
    const seed = await seedWorkflowCancelTarget(db, companyId, agentId, {
      run: {
        terminalOutcome: "succeeded", terminalDecidedAt: new Date(),
        terminalDecisionSource: "heartbeat_terminal:succeeded",
      },
    });
    const now = new Date();
    const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
    expect(result).toEqual({ executed: 1, failed: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.terminalOutcome).toBe("succeeded");
    // 먼저 결정된 근거가 보존된다 — 종결 취소 효과가 덮어쓰지 않는다.
    expect(run?.terminalDecisionSource).toBe("heartbeat_terminal:succeeded");
    expect(run?.executorOwnerReleasedAt).not.toBeNull();
    const [parent] = await db.select().from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, seed.run.id));
    expect(parent?.terminalOutcome).toBe("succeeded");
    expect(parent?.terminalDecisionSource).toBe("heartbeat_terminal:succeeded");
  }, 20000);

  it("already-settled target leaves the intent pending for reprocessing (existing contract)", async () => {
    const seed = await seedWorkflowCancelTarget(db, companyId, agentId, {
      run: { status: "succeeded", finishedAt: new Date() },
    });
    const now = new Date();
    const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
    expect(result).toEqual({ executed: 0, failed: 1 });
    const [intent] = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.id, seed.intentId));
    expect(intent?.status).toBe("pending");
    expect(intent?.attemptCount).toBe(1);
    expect(intent?.lastError).toContain("heartbeat run already settled before cancel effect");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
    expect(run?.status).toBe("succeeded");
  }, 20000);

  it("flag OFF: legacy cancel is byte-identical (no evidence evaluation, no finalization)", async () => {
    await db.update(instanceSettings)
      .set({ experimental: {} } as never)
      .where(eq(instanceSettings.singletonKey, "default"));
    try {
      const seed = await seedWorkflowCancelTarget(db, companyId, agentId, { stepCompleted: true });
      const now = new Date();
      const result = await executeTerminalEffectIntents(db, seed.decisionId, now);
      expect(result).toEqual({ executed: 1, failed: 0 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.run.id));
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("cancelled");
      expect(run?.terminalOutcome).toBeNull();
      expect(run?.terminalDecisionSource).toBeNull();
      expect(run?.executorOwnerReleasedAt).toBeNull();
      const [parent] = await db.select().from(heartbeatRunFinalizations)
        .where(eq(heartbeatRunFinalizations.heartbeatRunId, seed.run.id));
      expect(parent).toBeUndefined();
    } finally {
      await db.update(instanceSettings)
        .set({ experimental: { enableHeartbeatFinalizationV1: true } } as never)
        .where(eq(instanceSettings.singletonKey, "default"));
    }
  }, 20000);
});
