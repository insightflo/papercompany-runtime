// engine-contract S19 — resume 과 lifecycle-active 점유의 현재(main) 계약 (#687 이후 계약).
// #687 에서 resume 표시는 슬롯 계산과 같은 기준(lifecycleActiveClause)으로 정해진다:
// 미정산 terminal v1 run 을 점유한 에이전트는 resume 직후 running, 점유가 없으면 idle 이다.
// 어느 쪽이든 pauseReason·pausedAt 은 지우고 점유(heartbeat_runs 행) 자체는 건드리지 않는다 —
// 점유 회수는 recovery 정산/종료 정리의 계약이다. flag OFF 에서는 raw running 카운트로
// legacy 와 같은 결과를 낸다(이 묶음은 v1 플래그 ON 만 고정한다).
// seed: 순수 DB 행 → entry: agentService.resume → assert: agents + heartbeat_runs 최종 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { agentService } from "../../services/agents.js";
import {
  MIN,
  describeEP,
  fetchAgent,
  occupiedRunCount,
  seedHeartbeatRun,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-resume-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

describeEP("engine-contract S19 — resume contract (#687 lifecycle-active occupancy)", () => {
  it("S19: 미정산 v1 run 을 점유한 paused 에이전트는 resume 표시가 running 이고 점유는 바꾸지 않는다", async () => {
    await w.db.update(agents).set({
      status: "paused",
      pauseReason: "budget",
      pausedAt: new Date(Date.now() - 30 * MIN),
    }).where(eq(agents.id, w.agentId));
    // lifecycle-active 점유 시드: terminal 이면서 미정산인 v1 run.
    const run = await seedHeartbeatRun(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      status: "cancelled",
      terminalOutcome: "cancelled",
      finalizationVersion: 1,
      settledAt: null,
      finishedAt: new Date(Date.now() - 10 * MIN),
    });
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(1);

    const resumed = await agentService(w.db).resume(w.agentId);
    expect(resumed).not.toBeNull();

    // #687 계약: 점유 중이면 표시는 running — 보드 표시와 실제 점유가 일치한다.
    const agent = await fetchAgent(w.db, w.agentId);
    expect(agent.status).toBe("running");
    expect(agent.pauseReason).toBeNull();
    expect(agent.pausedAt).toBeNull();

    // 점유 자체는 resume 이 건드리지 않는다 — 정산은 recovery lane 의 계약.
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(1);
    const [row] = await w.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row.status).toBe("cancelled");
  });

  it("S19-b: lifecycle-active 점유가 없는 paused 에이전트의 resume 표시는 idle 이다", async () => {
    // 직전 시나리오의 점유를 정산(settled)해 점유 0 상태를 만들고 다시 paused 로 둔다.
    await w.db.update(heartbeatRuns).set({ settledAt: new Date() })
      .where(eq(heartbeatRuns.agentId, w.agentId));
    await w.db.update(agents).set({
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date(Date.now() - 5 * MIN),
    }).where(eq(agents.id, w.agentId));
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(0);

    const resumed = await agentService(w.db).resume(w.agentId);
    expect(resumed).not.toBeNull();

    // #687 계약의 반대 가지: 점유 0 이면 표시는 idle — 점유 없이 running 으로 남으면 안 된다.
    const agent = await fetchAgent(w.db, w.agentId);
    expect(agent.status).toBe("idle");
    expect(agent.pauseReason).toBeNull();
    expect(agent.pausedAt).toBeNull();
  });
});
