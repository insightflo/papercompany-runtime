// engine-contract S09 — agents.status 와 lifecycle-active 점유의 패리티 (#680 회귀).
// seed: 순수 DB 행 → entry: runMissionTerminalCleanup / recoverTerminalUnsettledRuns /
//   reconcilePersistedAgentStatusOnStartup → assert: agents.status + heartbeat_runs 최종 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, missions } from "@paperclipai/db";
import { runMissionTerminalCleanup } from "../../services/missions/terminal-cleanup-fence.js";
import { recoverTerminalUnsettledRuns } from "../../services/heartbeat-finalization/recovery.js";
import { reconcilePersistedAgentStatusOnStartup } from "../../services/agents.js";
import {
  MIN,
  describeEP,
  fetchAgent,
  occupiedRunCount,
  seedHeartbeatRun,
  seedMissionV1Run,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;
let off: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-occupancy-", { finalizationV1: true });
  off = await startContractDb("contract-occupancy-off-", {});
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
  await off.temp.cleanup();
});

describeEP("engine-contract S09 — agent status ↔ lifecycle-active occupancy (#680)", () => {
  it("S09: 미정산 terminal run 이 점유를 유지하는 동안 표시는 running, 정산·스윕 후 idle — flag OFF 는 레거시", async () => {
    // 점유 시작 상태: 에이전트가 running run 을 집행 중.
    await w.db.update(agents).set({ status: "running" }).where(eq(agents.id, w.agentId));
    const seed = await seedMissionV1Run(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      mission: { status: "completed" },
    });
    const now = new Date();
    const [snapshot] = await w.db.select().from(missions).where(eq(missions.id, seed.mission.id));
    const result = await runMissionTerminalCleanup(w.db, {
      companyId: w.companyId,
      missionId: seed.mission.id,
      status: "completed",
      now,
      completedAt: now,
      missionSnapshot: snapshot!,
      pendingMissionUpdates: { status: "completed", updatedAt: now },
    });
    expect(result.aborted).toBe(false);

    // terminal-but-unsettled v1 run = lifecycle-active 점유 → 표시는 idle 이 되면 안 된다.
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(1);
    expect((await fetchAgent(w.db, w.agentId)).status).toBe("running");

    // 정산 recovery 가 점유를 회수하면 표시도 idle 로 회복된다.
    const processed = await recoverTerminalUnsettledRuns(w.db, new Date(now.getTime() + 10 * MIN), 5 * MIN);
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(0);
    expect((await fetchAgent(w.db, w.agentId)).status).toBe("idle");

    // 재시작 스윕은 같은 점유 기준을 쓴다 — 점유 0 이면 idle 유지(멱등).
    await reconcilePersistedAgentStatusOnStartup(w.db);
    expect((await fetchAgent(w.db, w.agentId)).status).toBe("idle");

    // flag OFF(레거시): 미정산 개념 없이 status='running' 만 점유 — cancelled run 은 점유 아님.
    await off.db.update(agents).set({ status: "running" }).where(eq(agents.id, off.agentId));
    const offRun = await seedHeartbeatRun(off.db, {
      companyId: off.companyId,
      agentId: off.agentId,
      status: "cancelled",
      finishedAt: new Date(Date.now() - 5 * MIN),
    });
    expect(await occupiedRunCount(off.db, off.agentId, false)).toBe(0);
    await reconcilePersistedAgentStatusOnStartup(off.db);
    expect((await fetchAgent(off.db, off.agentId)).status).toBe("idle");
    const [untouched] = await off.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, offRun.id));
    expect(untouched.status).toBe("cancelled");
  });
});
