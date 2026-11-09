// server/src/__tests__/lifecycle-predicate-unification.integration.test.ts
//
// [계약] TS 하드닝 트랙 #4 상태 판정 술어 단일화(2026-11-09) 회귀 증거.
//   - rework-liveness: stale running step(정산된 heartbeat)은 활동으로 인정하지 않는다 —
//     #683 reconciler/deadlock 게이트와 동일 계약. 수정 전 이 시험은 실패한다.
//   - in-flight 점유(미션 런타임 busy 판정·재시도 억제): V1 ON 에서 terminal-but-unsettled
//     run 은 점유를 유지한다. OFF 에서는 queued/running 만 인정 — 레거시와 바이트 동일.
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
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hasActiveWorkflowReworkIteration } from "../services/workflow/rework-liveness.js";
import { hasActiveWorkflowRetryRecoveryExecution } from "../services/workflow/retry-execution-state.js";
import { hasBackingHeartbeatRun } from "../services/missions/mission-runtime-manager.js";
import { sweepTerminalMissionOrphanRuns } from "../services/missions/terminal-mission-orphan-sweep.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip predicate-unification tests: ${support.reason ?? "unsupported"}`);

const MIN = 60 * 1000;
type TestDb = ReturnType<typeof createDb>;

async function seedHeartbeat(db: TestDb, input: {
  companyId: string; agentId: string; issueId?: string | null;
  workflowStepRunId?: string | null; status: string;
  settledAt?: Date | null; finalizationVersion?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id, companyId: input.companyId, agentId: input.agentId,
    issueId: input.issueId ?? null, invocationSource: "assignment", triggerDetail: "system",
    status: input.status, workflowStepRunId: input.workflowStepRunId ?? null,
    workflowExecutionGeneration: input.workflowStepRunId ? 0 : null,
    executionScopeKind: input.workflowStepRunId ? "workflow_step" : "issue_nonworkflow",
    finalizationVersion: input.finalizationVersion ?? 1,
    executionEpoch: 0, executionToken: randomUUID(),
    executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
    executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * MIN),
    settledAt: input.settledAt ?? null, processPid: null,
    startedAt: new Date(Date.now() - 30 * MIN),
    ...(input.status !== "running" && input.status !== "queued"
      ? { finishedAt: new Date(Date.now() - 10 * MIN) } : {}),
  });
  return id;
}

describeEP("lifecycle predicate unification (rework gate + in-flight occupancy)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("predicate-unify-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PredCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Pred agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [mission] = await db.insert(missions).values({
      companyId, ownerAgentId: agentId, title: "Pred mission", status: "active",
    }).returning();
    missionId = mission.id;
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
  });
  afterAll(() => { tempDb = null; });

  async function seedReworkStep(status: string, settledAt: Date | null) {
    const [definition] = await db.insert(workflowDefinitions).values({
      companyId, name: `Pred wf ${randomUUID()}`,
      stepsJson: [{ id: "a", name: "A", agentId, dependencies: [] }],
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      companyId, workflowId: definition.id, missionId: null,
      status: "running", triggeredBy: "test", startedAt: new Date(Date.now() - 90 * MIN),
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, missionId: null, title: "rework step issue", status: "cancelled",
      assigneeAgentId: agentId, originKind: "workflow_execution", originRunId: run.id,
    }).returning();
    const [step] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "a", status: "running", issueId: issue.id,
      iterationIndex: 1, startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
    }).returning();
    await seedHeartbeat(db, {
      companyId, agentId, issueId: issue.id, workflowStepRunId: step.id,
      status, settledAt,
    });
    return run;
  }

  it("stale running rework step with settled heartbeat no longer counts as activity", async () => {
    const run = await seedReworkStep("succeeded", new Date(Date.now() - 80 * MIN));
    expect(await hasActiveWorkflowReworkIteration(db, { companyId, workflowRunId: run.id })).toBe(false);
  });

  it("live running heartbeat keeps the rework iteration protected", async () => {
    const run = await seedReworkStep("running", null);
    expect(await hasActiveWorkflowReworkIteration(db, { companyId, workflowRunId: run.id })).toBe(true);
  });

  it("terminal-but-unsettled v1 heartbeat keeps the rework iteration protected", async () => {
    const run = await seedReworkStep("succeeded", null);
    expect(await hasActiveWorkflowReworkIteration(db, { companyId, workflowRunId: run.id })).toBe(true);
  });

  it("unsettled-terminal issue heartbeat suppresses retry recovery dispatch", async () => {
    const [issue] = await db.insert(issues).values({
      companyId, missionId, title: "retry suppressed issue", status: "todo",
      assigneeAgentId: agentId,
    }).returning();
    await seedHeartbeat(db, {
      companyId, agentId, issueId: issue.id, status: "failed", settledAt: null,
    });
    expect(await hasActiveWorkflowRetryRecoveryExecution(db, { companyId, issueId: issue.id })).toBe(true);
  });

  it("unsettled-terminal heartbeat keeps mission runtime backed (busy)", async () => {
    const [issue] = await db.insert(issues).values({
      companyId, missionId, title: "mission backed issue", status: "in_progress",
      assigneeAgentId: agentId,
    }).returning();
    await seedHeartbeat(db, {
      companyId, agentId, issueId: issue.id, status: "timed_out", settledAt: null,
    });
    expect(await hasBackingHeartbeatRun(db, {
      agentId, missionId, currentIssueId: issue.id,
    })).toBe(true);
  });

  it("flag OFF keeps legacy byte-identical semantics: unsettled run does NOT count", async () => {
    await db.update(instanceSettings)
      .set({ experimental: { enableHeartbeatFinalizationV1: false } })
      .where(eq(instanceSettings.singletonKey, "default"));
    try {
      const [issue] = await db.insert(issues).values({
        companyId, missionId, title: "flag-off issue", status: "todo",
        assigneeAgentId: agentId,
      }).returning();
      await seedHeartbeat(db, {
        companyId, agentId, issueId: issue.id, status: "failed", settledAt: null,
      });
      // OFF: IN ('queued','running') 와 동일 — failed+unsettled 는 활동이 아니다.
      expect(await hasActiveWorkflowRetryRecoveryExecution(db, { companyId, issueId: issue.id })).toBe(false);
    } finally {
      await db.update(instanceSettings)
        .set({ experimental: { enableHeartbeatFinalizationV1: true } })
        .where(eq(instanceSettings.singletonKey, "default"));
    }
  });

  it("orphan sweep counts a run cancelled by its own cleanup (cancel domain stays literal)", async () => {
    // agy 검수 수정 증거: countActiveRuns/후보 선별은 취소 대상 도메인 — in-flight 술어를
    // 쓰면 V1 ON 에서 cleanup 이 방금 cancelled+미정산으로 둔 run 이 runsRemaining 에
    // 잡혀 runsCancelled=0 이 되고 감사로그가 누락된다.
    const [completedMission] = await db.insert(missions).values({
      companyId, ownerAgentId: agentId, title: "done mission", status: "completed",
      completedAt: new Date(Date.now() - 60 * MIN),
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, missionId: completedMission.id, title: "orphan issue", status: "in_progress",
      assigneeAgentId: agentId,
    }).returning();
    const runId = await seedHeartbeat(db, {
      companyId, agentId, issueId: issue.id, status: "queued", settledAt: null,
    });
    await db.update(heartbeatRuns)
      .set({ updatedAt: new Date(Date.now() - 30 * MIN) })
      .where(eq(heartbeatRuns.id, runId));

    const result = await sweepTerminalMissionOrphanRuns(db, new Date());
    expect(result.cancelledRuns).toBe(1);
    expect(result.sweptMissions).toBe(1);
  });
});
