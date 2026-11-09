// server/src/__tests__/agent-status-slot-parity.integration.test.ts
//
// [C2 2026-11-08] 보드 표시(agents.status)와 슬롯 계산(countRunningRunsForAgent —
// lifecycleActiveClause)이 같은 기준을 쓰는지 검증한다.
//   - 미션 종료 정리가 run 을 종결하면 recovery 정산(grace) 전까지 run 은 lifecycle-active
//     로 슬롯을 점유한다. 이 창구에 에이전트가 idle 로 표시되면 표시/슬롯 불일치가 된다
//     (2026-11-07 A1 관측: idle 표시 + 6 슬롯 점유 — resetSafeTerminalAgents가
//     status IN ('queued','running') 만 보고 idle 로 덮어쓴 경로).
//   - 서버 재시작 스윕(reconcilePersistedAgentStatusOnStartup)도 같은 기준을 써야 한다.
//   - recovery lane 이 정산을 마치면 점유가 사라지므로 표시도 idle 로 회복되어야 한다.
//   - flag OFF 에서는 레거시 기준(queued/running 만)이 바이트 동일하게 보존된다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { recoverTerminalUnsettledRuns } from "../services/heartbeat-finalization/recovery.js";
import { reconcilePersistedAgentStatusOnStartup } from "../services/agents.js";
import { commitAgentResume } from "../services/heartbeat-agent-resume.js";
import { budgetService } from "../services/budgets.js";
import { demoteAgentStuckDetachedAgentStatus } from "../services/heartbeat.js";
import { resetSafeTerminalAgents } from "../services/missions/terminal-cleanup-resources.js";
import { agentWikiService } from "../services/agent-wiki.js";
import { DETACHED_PROCESS_ERROR_CODE } from "../services/heartbeat-process-liveness.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip agent-status parity tests: ${support.reason ?? "unsupported"}`);

async function seedMissionRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
): Promise<{ missionId: string; runId: string }> {
  const [mission] = await db.insert(missions).values({
    companyId, ownerAgentId: agentId, title: `Parity mission ${randomUUID()}`, status: "active",
  }).returning();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  const [issue] = await db.insert(issues).values({
    companyId, missionId: mission.id, title: "Parity issue", status: "in_progress",
    assigneeAgentId: agentId,
  }).returning();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: {}, status: "claimed", runId,
  } as never);
  await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId, issueId: issue.id, invocationSource: "assignment",
    triggerDetail: "system", status: "running", wakeupRequestId,
    workflowStepRunId: null, workflowExecutionGeneration: null,
    executionScopeKind: "issue_nonworkflow",
    finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
    executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
    executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    processPid: null,
  } as never);
  await db.update(issues).set({
    checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
  }).where(eq(issues.id, issue.id));
  return { missionId: mission.id, runId };
}

describeEP("agent status display matches lifecycle slot calculation", () => {
  let db!: ReturnType<typeof createDb>;
  let offDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let offTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-status-parity-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ParityCo", status: "active" });
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
    offTempDb = await startEmbeddedPostgresTestDatabase("agent-status-parity-off-");
    offDb = createDb(offTempDb.connectionString);
  }, 120_000);
  afterAll(() => { tempDb = null; offTempDb = null; });

  async function seedAgent(name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name, status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return agentId;
  }
  const agentStatus = async (agentId: string) =>
    (await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)))[0]?.status;

  // [idle-def 2026-11-09] 시나리오 시험용 최소 run fixture. seedMissionRun 과 같은 필수 컬럼만
  // 채우고 상태/에러코드/정산 상태는 호출부가 지정한다.
  async function insertRun(
    target: ReturnType<typeof createDb>,
    agentCompanyId: string,
    agentId: string,
    overrides: {
      status: "queued" | "running" | "cancelled";
      errorCode?: string | null;
      finalizationVersion?: number;
      finishedAt?: Date | null;
    },
  ): Promise<{ id: string; agentId: string; companyId: string }> {
    const runId = randomUUID();
    await target.insert(heartbeatRuns).values({
      id: runId, companyId: agentCompanyId, agentId, issueId: null, invocationSource: "assignment",
      triggerDetail: "system", status: overrides.status, wakeupRequestId: null,
      workflowStepRunId: null, workflowExecutionGeneration: null,
      executionScopeKind: "issue_nonworkflow",
      errorCode: overrides.errorCode ?? null,
      finalizationVersion: overrides.finalizationVersion ?? 1, executionEpoch: 0,
      executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      finishedAt: overrides.finishedAt ?? (overrides.status === "running" ? null : new Date()),
      processPid: null,
    } as never);
    return { id: runId, agentId, companyId: agentCompanyId };
  }

  it("mission terminal cleanup keeps the agent non-idle while the cancelled v1 run still occupies a slot", async () => {
    const agentId = await seedAgent("Cleanup parity agent");
    const seed = await seedMissionRun(db, companyId, agentId);
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, {
      companyId, missionId: seed.missionId, status: "completed", now, completedAt: now,
      missionSnapshot: (await db.select().from(missions).where(eq(missions.id, seed.missionId)))[0]!,
      pendingMissionUpdates: { status: "completed", updatedAt: now },
    });
    expect(result.aborted).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run?.status).toBe("cancelled");
    expect(run?.settledAt).toBeNull();
    // 미정산 terminal run 이 슬롯을 점유하는 동안 표시도 idle 이어서는 안 된다.
    expect(await agentStatus(agentId)).toBe("running");

    // recovery 정산이 점유를 회수하면 표시도 idle 로 돌아간다.
    const processed = await recoverTerminalUnsettledRuns(db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(settled?.settledAt).not.toBeNull();
    expect(await agentStatus(agentId)).toBe("idle");
  }, 30_000);

  it("startup sweep does not idle an agent whose terminal-but-unsettled v1 run still occupies a slot", async () => {
    const agentId = await seedAgent("Startup parity agent");
    const seed = await seedMissionRun(db, companyId, agentId);
    const now = new Date();
    await runMissionTerminalCleanup(db, {
      companyId, missionId: seed.missionId, status: "cancelled", now, completedAt: null,
      missionSnapshot: (await db.select().from(missions).where(eq(missions.id, seed.missionId)))[0]!,
      pendingMissionUpdates: { status: "cancelled", updatedAt: now },
    });
    expect(await agentStatus(agentId)).toBe("running");
    await reconcilePersistedAgentStatusOnStartup(db);
    expect(await agentStatus(agentId)).toBe("running");

    const processed = await recoverTerminalUnsettledRuns(db, new Date(now.getTime() + 10 * 60 * 1000), 5 * 60 * 1000);
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(await agentStatus(agentId)).toBe("idle");
    // 정산 후 재시작 스윕은 여전히 멱등해야 한다.
    await reconcilePersistedAgentStatusOnStartup(db);
    expect(await agentStatus(agentId)).toBe("idle");
  }, 30_000);

  it("flag OFF keeps the legacy criterion: terminal-unsettled rows do not block the idle reset", async () => {
    const offCompanyId = randomUUID(), offAgentId = randomUUID();
    await offDb.insert(companies).values({ id: offCompanyId, name: "ParityLegacyCo", status: "active" });
    await offDb.insert(agents).values({
      id: offAgentId, companyId: offCompanyId, name: "Legacy agent", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const seed = await seedMissionRun(offDb, offCompanyId, offAgentId);
    const now = new Date();
    await runMissionTerminalCleanup(offDb, {
      companyId: offCompanyId, missionId: seed.missionId, status: "cancelled", now, completedAt: null,
      missionSnapshot: (await offDb.select().from(missions).where(eq(missions.id, seed.missionId)))[0]!,
      pendingMissionUpdates: { status: "cancelled", updatedAt: now },
    });
    await reconcilePersistedAgentStatusOnStartup(offDb);
    const status = (await offDb.select({ status: agents.status }).from(agents).where(eq(agents.id, offAgentId)))[0]?.status;
    expect(status).toBe("idle");
  }, 30_000);

  // [idle-def 2026-11-09 W7] 수동 pause → resume 창구: resume 계열이 표시를 무조건 idle 로
  // 덮지 않고 슬롯 계산(lifecycleActiveClause)과 같은 기준으로 정하는지 검증한다.
  it("manual resume keeps a running display while an unsettled cancelled v1 run still occupies a slot", async () => {
    const agentId = await seedAgent("Manual resume parity agent");
    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() })
      .where(eq(agents.id, agentId));
    await insertRun(db, companyId, agentId, { status: "cancelled", errorCode: "cancelled" });

    const resumed = await commitAgentResume(db, agentId);
    // 미정산 terminal v1 run 이 점유 중이면 resume 직후 표시도 running 이어야 한다.
    expect(resumed?.status).toBe("running");

    // 플래그 OFF 레거시 보존: raw running 이 없으므로 기존대로 idle.
    const offCompanyId = randomUUID(), offAgentId = randomUUID();
    await offDb.insert(companies).values({ id: offCompanyId, name: "ResumeLegacyCo", status: "active", issuePrefix: "R" + offCompanyId.slice(0, 8) });
    await offDb.insert(agents).values({
      id: offAgentId, companyId: offCompanyId, name: "Resume legacy agent", status: "paused",
      pauseReason: "manual", pausedAt: new Date(),
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await insertRun(offDb, offCompanyId, offAgentId, { status: "cancelled", errorCode: "cancelled" });
    const offResumed = await commitAgentResume(offDb, offAgentId);
    expect(offResumed?.status).toBe("idle");
  }, 30_000);

  // [idle-def 2026-11-09 W8] 예산 초과 pause → raise 후 자동 resume 창구도 같은 기준을 쓰는지 검증한다.
  it("budget raise auto-resume keeps a running display while an unsettled cancelled v1 run occupies a slot", async () => {
    const agentId = await seedAgent("Budget resume parity agent");
    await db.update(agents).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() })
      .where(eq(agents.id, agentId));
    await insertRun(db, companyId, agentId, { status: "cancelled", errorCode: "cancelled" });

    await budgetService(db).upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, amount: 500_000 }, null);
    expect(await agentStatus(agentId)).toBe("running");

    // 플래그 OFF 레거시 보존: raw running 이 없으므로 기존대로 idle.
    const offCompanyId = randomUUID(), offAgentId = randomUUID();
    await offDb.insert(companies).values({ id: offCompanyId, name: "BudgetLegacyCo", status: "active", issuePrefix: "B" + offCompanyId.slice(0, 8) });
    await offDb.insert(agents).values({
      id: offAgentId, companyId: offCompanyId, name: "Budget legacy agent", status: "paused",
      pauseReason: "budget", pausedAt: new Date(),
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await insertRun(offDb, offCompanyId, offAgentId, { status: "cancelled", errorCode: "cancelled" });
    await budgetService(offDb).upsertPolicy(offCompanyId, { scopeType: "agent", scopeId: offAgentId, amount: 500_000 }, null);
    const offStatus = (await offDb.select({ status: agents.status }).from(agents).where(eq(agents.id, offAgentId)))[0]?.status;
    expect(offStatus).toBe("idle");
  }, 30_000);

  // [idle-def 2026-11-09 W9] detached 강등 창구: 강등 보류 판정이 raw status='running' 이 아니라
  // 공용 술어(lifecycleActiveClause)로 형제 점유를 세는지 검증한다.
  it("detached demotion is suppressed while an unsettled terminal sibling still occupies a slot", async () => {
    const agentId = await seedAgent("Detached demote parity agent");
    const stale = new Date(Date.now() - 15 * 60 * 1000);
    await db.update(agents).set({ updatedAt: stale }).where(eq(agents.id, agentId));
    const detachedRun = await insertRun(db, companyId, agentId, {
      status: "running", errorCode: DETACHED_PROCESS_ERROR_CODE,
    });
    await insertRun(db, companyId, agentId, { status: "cancelled", errorCode: "cancelled" });

    await demoteAgentStuckDetachedAgentStatus(db, detachedRun, new Date(), agentWikiService(db));
    // 미정산 terminal 형제 run 이 점유 중이면 error 로 강등하지 않는다.
    expect(await agentStatus(agentId)).toBe("running");

    // 정상 강등 계약 유지: 점유가 없는 detached 유예 agent 는 여전히 error 로 강등된다.
    const lonelyId = await seedAgent("Detached demote lonely agent");
    await db.update(agents).set({ updatedAt: stale }).where(eq(agents.id, lonelyId));
    const lonelyRun = await insertRun(db, companyId, lonelyId, {
      status: "running", errorCode: DETACHED_PROCESS_ERROR_CODE,
    });
    await demoteAgentStuckDetachedAgentStatus(db, lonelyRun, new Date(), agentWikiService(db));
    expect(await agentStatus(lonelyId)).toBe("error");

    // 플래그 OFF 레거시 보존: raw running 판정 — 미정산 terminal 형제는 강등을 막지 않는다.
    const offCompanyId = randomUUID(), offAgentId = randomUUID();
    await offDb.insert(companies).values({ id: offCompanyId, name: "DemoteLegacyCo", status: "active", issuePrefix: "D" + offCompanyId.slice(0, 8) });
    await offDb.insert(agents).values({
      id: offAgentId, companyId: offCompanyId, name: "Demote legacy agent", status: "running",
      updatedAt: stale,
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const offDetachedRun = await insertRun(offDb, offCompanyId, offAgentId, {
      status: "running", errorCode: DETACHED_PROCESS_ERROR_CODE,
    });
    await insertRun(offDb, offCompanyId, offAgentId, { status: "cancelled", errorCode: "cancelled" });
    await demoteAgentStuckDetachedAgentStatus(offDb, offDetachedRun, new Date(), agentWikiService(offDb));
    const offStatus = (await offDb.select({ status: agents.status }).from(agents).where(eq(agents.id, offAgentId)))[0]?.status;
    expect(offStatus).toBe("error");
  }, 30_000);

  // [idle-def 2026-11-09 C] queued-only 창구: queued run 은 슬롯(active)은 아니지만 in-flight
  // 이다(in-flight ⊇ active). 종료 정리는 idle 로 덮지 않고, 시작 스윕은 idle 로 정리한다.
  it("queued-only window keeps cleanup non-idle while the startup sweep idles (in-flight is a superset of active)", async () => {
    const agentId = await seedAgent("Queued only parity agent");
    await insertRun(db, companyId, agentId, { status: "queued" });

    await resetSafeTerminalAgents(db, companyId, [agentId], new Date());
    expect(await agentStatus(agentId)).toBe("running");

    await reconcilePersistedAgentStatusOnStartup(db);
    expect(await agentStatus(agentId)).toBe("idle");
  }, 30_000);
});
