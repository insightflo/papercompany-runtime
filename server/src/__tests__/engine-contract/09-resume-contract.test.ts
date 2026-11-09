// engine-contract S19 — resume 과 lifecycle-active 점유의 현재(main) 계약 (#687 병합 전 기준선 고정).
// 현재 main 에서 resume 은 점유와 무관하게 status 를 idle 로 쓴다 — 미정산 v1 run 이 점유를
// 유지하는 에이전트도 resume 직후 표시는 idle 이 된다. 이 시험은 그 '기준선 계약'을 고정한다.
// idle-def(#687) 병합 시 기대값이 "running" 으로 바뀌는 변경 신호 역할을 한다(보고서 참조).
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

describeEP("engine-contract S19 — resume contract on main (#687 baseline)", () => {
  it("S19: 미정산 v1 run 을 점유한 paused 에이전트도 resume 은 idle 을 쓰고 점유는 바꾸지 않는다", async () => {
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

    // 현재 main 계약: resume 은 점유를 보지 않고 표시를 idle 로 기록한다.
    const agent = await fetchAgent(w.db, w.agentId);
    expect(agent.status).toBe("idle");
    expect(agent.pauseReason).toBeNull();
    expect(agent.pausedAt).toBeNull();

    // 점유 자체는 resume 이 건드리지 않는다 — 정산은 recovery lane 의 계약.
    expect(await occupiedRunCount(w.db, w.agentId)).toBe(1);
    const [row] = await w.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row.status).toBe("cancelled");
  });
});
