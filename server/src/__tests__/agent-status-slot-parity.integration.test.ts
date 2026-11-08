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
});
