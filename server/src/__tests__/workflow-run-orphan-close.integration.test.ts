// server/src/__tests__/workflow-run-orphan-close.integration.test.ts
//
// [계약] 장기 running workflow run 고아 재발 방지 수리(2026-11-08 longrun-check §6-①/②/③, §8-2).
//   R1: 미션 취소 경로가 그 미션의 비종결 workflow_runs 을 기존 취소 계약
//       (cancelOutstandingWorkflowIssues · syncCancelledWorkflowRunState · 자식 전파)으로 닫는다.
//       완료 판정 증거(종결 run/step · done 이슈 · 성공 결과)는 덮어쓰지 않는다(#679/#682 원칙).
//   R2: stuck/deadlock reconciler 의 "step 행 running = 활동 중" 게이트를 실제 생존 기준으로
//       좁힌다(lifecycleActiveClause 의 heartbeat 술어 재사용). 살아 있는 실행(queued/running,
//       terminal-but-unsettled v1)은 계속 보호한다.
//   잔여(이번 범위 밖, 수리 보고서 참조): 종결 run 아래 비종결 step 행 잔재, rework-liveness 게이트의
//       동일 "step running = 활동 중" 패턴.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
import { reconcileDeadlockedWorkflowRuns } from "../services/workflow/deadlock-reconciler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip orphan-run-close tests: ${support.reason ?? "unsupported"}`);

const MIN = 60 * 1000;

type TestDb = ReturnType<typeof createDb>;

/** 이슈 실행(assignment) heartbeat run 시드 — settled 여부/상태를 오버라이드로 제어. */
async function seedHeartbeatRun(
  db: TestDb,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    workflowStepRunId?: string | null;
    status: string;
    terminalOutcome?: string | null;
    settledAt?: Date | null;
    finalizationVersion?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId ?? null,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: input.status,
    workflowStepRunId: input.workflowStepRunId ?? null,
    workflowExecutionGeneration: input.workflowStepRunId ? 0 : null,
    executionScopeKind: input.workflowStepRunId ? "workflow_step" : "issue_nonworkflow",
    finalizationVersion: input.finalizationVersion ?? 1,
    executionEpoch: 0,
    executionToken: randomUUID(),
    executorOwnerId: "default",
    executorOwnerLeaseEpoch: 1,
    executorOwnerLeaseToken: randomUUID(),
    executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * MIN),
    terminalOutcome: input.terminalOutcome ?? null,
    settledAt: input.settledAt ?? null,
    processPid: null,
    startedAt: new Date(Date.now() - 30 * MIN),
    ...(input.status !== "running" && input.status !== "queued"
      ? { finishedAt: new Date(Date.now() - 10 * MIN) }
      : {}),
    ...(input.status === "succeeded" ? { resultJson: { ok: true }, exitCode: 0 } : {}),
  });
  return id;
}

describeEP("workflow run orphan close (R1 mission cancel / R2 liveness gates)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("orphan-run-close-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "OrphanCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Orphan agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // A1 실효 플래그와 동일하게 두 v1 플래그를 켠다(lifecycleActiveClause·run-terminal-boundary 경로).
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true, enableRunTerminalBoundaryV1: true },
    } as never);
  });
  afterAll(() => { tempDb = null; });

  const runById = async (id: string) => {
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
    return row!;
  };
  const stepById = async (id: string) => {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id));
    return row!;
  };

  describe("R1 mission cancel closes non-terminal workflow runs via the cancellation contract", () => {
    it("cancels the mission's running workflow run (issue/step cleanup, child propagation) and preserves completed evidence", async () => {
      const { cancelMissionWorkflowRuns } = await import("../services/workflow/workflow-cancellation.js");
      expect(typeof cancelMissionWorkflowRuns).toBe("function");

      const [mission] = await db.insert(missions).values({
        companyId, ownerAgentId: agentId, title: "Orphan mission", status: "cancelled",
      }).returning();

      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Orphan wf ${randomUUID()}`,
        stepsJson: [
          { id: "a", name: "A", agentId, dependencies: [] },
          { id: "b", name: "B", agentId, dependencies: ["a"] },
        ],
      }).returning();

      // 미정산 run A — running step(실행 이슈 열림) + pending step(무이슈). heartbeat executor 는 이미 종료·정산됨.
      const [runA] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: mission.id,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
      }).returning();
      const [issueA] = await db.insert(issues).values({
        companyId, missionId: mission.id, title: "step a issue", status: "in_progress",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: runA.id,
      }).returning();
      const deadHeartbeatId = await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issueA.id, status: "cancelled",
        terminalOutcome: "cancelled", settledAt: new Date(Date.now() - 20 * MIN),
      });
      await db.update(issues)
        .set({ executionRunId: deadHeartbeatId, executionLockedAt: new Date() })
        .where(eq(issues.id, issueA.id));
      const [stepA1] = await db.insert(workflowStepRuns).values({
        workflowRunId: runA.id, stepId: "a", status: "running", issueId: issueA.id,
        startedAt: new Date(Date.now() - 80 * MIN), metadata: {},
      }).returning();
      const [stepAb] = await db.insert(workflowStepRuns).values({
        workflowRunId: runA.id, stepId: "b", status: "pending", metadata: {},
      }).returning();

      // 자식 run(부모 취소 전파 대상) — linked 자식 계약대로 invocation 링크까지 시드.
      const [childRun] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: mission.id,
        status: "running", triggeredBy: "workflow-step",
        parentRunId: runA.id, parentStepRunId: stepAb.id,
        startedAt: new Date(Date.now() - 80 * MIN),
      }).returning();
      await db.insert(workflowStepInvocations).values({
        companyId, parentStepRunId: stepAb.id, childRunId: childRun.id,
        state: "linked", generation: 1, targetWorkflowId: definition.id,
      });

      // 성공 증거 run B — 종결 run + completed step + done 이슈(+성공 heartbeat 결과)
      const [runB] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: mission.id,
        status: "completed", triggeredBy: "test",
        startedAt: new Date(Date.now() - 120 * MIN), completedAt: new Date(Date.now() - 60 * MIN),
      }).returning();
      const [issueB] = await db.insert(issues).values({
        companyId, missionId: mission.id, title: "step evidence issue", status: "done",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: runB.id,
        completedAt: new Date(Date.now() - 61 * MIN),
      }).returning();
      const evidenceHeartbeatId = await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issueB.id, status: "succeeded",
        terminalOutcome: "succeeded", settledAt: new Date(Date.now() - 61 * MIN),
      });
      const [stepB1] = await db.insert(workflowStepRuns).values({
        workflowRunId: runB.id, stepId: "a", status: "completed", issueId: issueB.id,
        startedAt: new Date(Date.now() - 100 * MIN), completedAt: new Date(Date.now() - 61 * MIN),
        metadata: {},
      }).returning();
      const runBCompletedAt = (await runById(runB.id)).completedAt!;
      const stepB1CompletedAt = stepB1.completedAt!;

      const result = await cancelMissionWorkflowRuns(db, { companyId, missionId: mission.id });
      expect(result.cancelledRunIds).toContain(runA.id);
      expect(result.cancelledRunIds).not.toContain(runB.id);

      // run A: 취소 계약으로 종결 + 자식 전파
      const a = await runById(runA.id);
      expect(a.status).toBe("cancelled");
      expect(a.completedAt).not.toBeNull();
      const child = await runById(childRun.id);
      expect(child.status).toBe("cancelled");

      // 성공 보존: 종결 run/step · done 이슈 · 성공 결과는 그대로
      const b = await runById(runB.id);
      expect(b.status).toBe("completed");
      expect(b.completedAt?.getTime()).toBe(runBCompletedAt.getTime());
      const b1 = await stepById(stepB1.id);
      expect(b1.status).toBe("completed");
      expect(b1.completedAt?.getTime()).toBe(stepB1CompletedAt.getTime());
      const [ib] = await db.select().from(issues).where(eq(issues.id, issueB.id));
      expect(ib?.status).toBe("done");
      const [evidenceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, evidenceHeartbeatId));
      expect(evidenceRun?.status).toBe("succeeded");
      expect(evidenceRun?.resultJson).toEqual({ ok: true });

      // run A 정리: 열린 실행 이슈 취소 + 실행 참조 해제, running step → failed, 무이슈 pending → skipped
      const [ia] = await db.select().from(issues).where(eq(issues.id, issueA.id));
      expect(ia?.status).toBe("cancelled");
      expect(ia?.executionRunId).toBeNull();
      expect(ia?.checkoutRunId).toBeNull();
      const a1 = await stepById(stepA1.id);
      expect(a1.status).toBe("failed");
      const [stepA2] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runA.id));
      // (stepA1 외 유일 step) — b 는 무이슈 pending → skipped
      const stepsA = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runA.id));
      // step b 는 취소된 자식 run 을 기다리던 부모 스텝 — 자식 취소 hook 이 child_run_cancelled 로 마감(failed).
      const stepAbRow = stepsA.find((s) => s.stepId === "b")!;
      expect(stepAbRow.status).toBe("failed");
      expect(stepAbRow.completedAt).not.toBeNull();

      // 장부: 취소 계약이 run A 의 전이를 남기고(자식 hook 전이도 함께), 성공 보존 run B 에는 쓰지 않는다
      const eventsA = await db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.workflowRunId, runA.id));
      expect(eventsA.some((e) => e.reasonCode === "workflow_cancellation")).toBe(true);
      const eventsB = await db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.workflowRunId, runB.id));
      expect(eventsB.length).toBe(0);
    });
  });

  describe("R2 stuck gate: step 'running' row alone is not liveness", () => {
    // 7aff807a 형태: running step 1개(장부·이슈·heartbeat 전부 사망) + pending 없음.
    it("stale running step with settled heartbeat no longer blocks the verdict path (0 pending)", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Stuck wf ${randomUUID()}`,
        stepsJson: [{ id: "a", name: "A", agentId, dependencies: [] }],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "stale step issue", status: "cancelled",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [step] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: step.id,
        status: "succeeded", terminalOutcome: "succeeded", settledAt: new Date(Date.now() - 80 * MIN),
      });

      const results = await reconcileStuckWorkflowRuns(db, 60);
      const mine = results.find((r) => r.runId === run.id);
      expect(mine?.action).toBe("recovered");
      const row = await runById(run.id);
      expect(row.status).toBe("failed");
      expect(row.completedAt).not.toBeNull();
    });

    // ca5e509b/e1c19496 형태: stale running step + pending 스텝들.
    it("stale running step with dead heartbeat lets pending steps converge (pending shape)", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Stuck wf ${randomUUID()}`,
        stepsJson: [
          { id: "a", name: "A", agentId, dependencies: [] },
          { id: "b", name: "B", agentId, dependencies: ["a"] },
        ],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "stale step issue (pending shape)", status: "cancelled",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [stepA] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
      }).returning();
      const [stepB] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "b", status: "pending", metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: stepA.id,
        status: "cancelled", terminalOutcome: "cancelled", settledAt: new Date(Date.now() - 80 * MIN),
      });

      const results = await reconcileStuckWorkflowRuns(db, 60);
      const mine = results.find((r) => r.runId === run.id);
      expect(mine?.action).toBe("recovered");
      expect((await runById(run.id)).status).toBe("failed");
      expect((await stepById(stepB.id)).status).toBe("skipped");
    });

    it("live running heartbeat execution stays protected", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Live wf ${randomUUID()}`,
        stepsJson: [{ id: "a", name: "A", agentId, dependencies: [] }],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "live step issue", status: "in_progress",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [step] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: step.id, status: "running",
      });

      const results = await reconcileStuckWorkflowRuns(db, 60);
      const mine = results.find((r) => r.runId === run.id);
      expect(mine?.action).toBe("skipped");
      expect(mine?.reason).toContain("Active workflow step execution is still running");
      expect((await runById(run.id)).status).toBe("running");
    });

    it("terminal-but-unsettled v1 heartbeat still protects the step (lifecycle predicate reuse)", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Unsettled wf ${randomUUID()}`,
        stepsJson: [{ id: "a", name: "A", agentId, dependencies: [] }],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "unsettled step issue", status: "in_progress",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [step] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: step.id,
        status: "succeeded", terminalOutcome: "succeeded", settledAt: null, finalizationVersion: 1,
      });

      const results = await reconcileStuckWorkflowRuns(db, 60);
      const mine = results.find((r) => r.runId === run.id);
      expect(mine?.action).toBe("skipped");
      expect((await runById(run.id)).status).toBe("running");
    });
  });

  describe("R2 deadlock gate: step 'running' row alone is not liveness", () => {
    it("deadlocked run with stale running step converges (skip + run failed)", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Dl wf ${randomUUID()}`,
        stepsJson: [
          { id: "a", name: "A", agentId, dependencies: [] },
          { id: "b", name: "B", agentId, dependencies: ["a"] },
          { id: "c", name: "C", agentId, dependencies: ["a"] },
        ],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 10 * MIN),
      }).returning();
      await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "failed",
        startedAt: new Date(Date.now() - 9 * MIN), completedAt: new Date(Date.now() - 8 * MIN), metadata: {},
      });
      const [stepB] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "b", status: "pending", metadata: {},
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "deadlock stale issue", status: "cancelled",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [stepC] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "c", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 9 * MIN), metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: stepC.id,
        status: "failed", terminalOutcome: "failed", settledAt: new Date(Date.now() - 8 * MIN),
      });

      const results = await reconcileDeadlockedWorkflowRuns(db, 5);
      const mine = results.find((r) => r.runId === run.id);
      expect(mine?.action).toBe("recovered");
      expect((await runById(run.id)).status).toBe("failed");
      expect((await stepById(stepB.id)).status).toBe("skipped");
    });

    it("deadlocked run with live heartbeat execution stays protected", async () => {
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, name: `Dl live wf ${randomUUID()}`,
        stepsJson: [
          { id: "a", name: "A", agentId, dependencies: [] },
          { id: "b", name: "B", agentId, dependencies: ["a"] },
          { id: "c", name: "C", agentId, dependencies: ["a"] },
        ],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        companyId, workflowId: definition.id, missionId: null,
        status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 10 * MIN),
      }).returning();
      await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "a", status: "failed",
        startedAt: new Date(Date.now() - 9 * MIN), completedAt: new Date(Date.now() - 8 * MIN), metadata: {},
      });
      await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "b", status: "pending", metadata: {},
      });
      const [issue] = await db.insert(issues).values({
        companyId, missionId: null, title: "deadlock live issue", status: "in_progress",
        assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
      }).returning();
      const [stepC] = await db.insert(workflowStepRuns).values({
        workflowRunId: run.id, stepId: "c", status: "running", issueId: issue.id,
        startedAt: new Date(Date.now() - 9 * MIN), metadata: {},
      }).returning();
      await seedHeartbeatRun(db, {
        companyId, agentId, issueId: issue.id, workflowStepRunId: stepC.id, status: "running",
      });

      const results = await reconcileDeadlockedWorkflowRuns(db, 5);
      expect(results.find((r) => r.runId === run.id && r.action === "recovered")).toBeUndefined();
      expect((await runById(run.id)).status).toBe("running");
    });
  });
});
