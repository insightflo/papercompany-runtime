// engine-contract S01·S02 — 미션 종결 cleanup 의 heartbeat 계약 (#679 회귀).
// seed: 순수 DB 행 → entry: runMissionTerminalCleanup / recoverTerminalUnsettledRuns → assert: 최종 DB 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRunFinalizations,
  issues,
  missions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  runMissionTerminalCleanup,
} from "../../services/missions/terminal-cleanup-fence.js";
import { recoverTerminalUnsettledRuns } from "../../services/heartbeat-finalization/recovery.js";
import {
  MIN,
  describeEP,
  fetchHeartbeatRun,
  seedMissionV1Run,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-cleanup-", { finalizationV1: true, runTerminalBoundaryV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

async function missionRow(missionId: string) {
  const [row] = await w.db.select().from(missions).where(eq(missions.id, missionId));
  return row!;
}

describeEP("engine-contract S01/S02 — mission terminal cleanup v1 finalization (#679)", () => {
  it("S01: 미션 completed cleanup 은 v1 run 을 계약대로 종결하고 정산 recovery 가 회수한다", async () => {
    const seed = await seedMissionV1Run(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      mission: { status: "completed" },
    });
    const now = new Date();
    const result = await runMissionTerminalCleanup(w.db, {
      companyId: w.companyId,
      missionId: seed.mission.id,
      status: "completed",
      now,
      completedAt: now,
      missionSnapshot: await missionRow(seed.mission.id),
      pendingMissionUpdates: { status: "completed", updatedAt: now },
    });
    expect(result.aborted).toBe(false);

    // 최종 행 계약: v1 취소 계약 — cancelled + finalizationVersion 1 유지 + settledAt 은 정산 전 null.
    const run = await fetchHeartbeatRun(w.db, seed.run.id);
    expect(run.status).toBe("cancelled");
    expect(run.terminalOutcome).toBe("cancelled");
    expect(run.finalizationVersion).toBe(1);
    expect(run.settledAt).toBeNull();
    expect(run.finishedAt).not.toBeNull();

    // finalization shadow ledger 행이 남는다.
    const finRows = await w.db
      .select()
      .from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
    expect(finRows.length).toBeGreaterThanOrEqual(1);

    // wakeup 큐: coalesced 재큐 계약상 종결 run 의 wakeup 은 실행 불가 상태로 남는다.
    const wakeups = await w.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, run.id));
    expect(wakeups.every((r) => r.status !== "queued")).toBe(true);

    // 정산 recovery (grace 경과 시각): settledAt 기록 + 이슈 잠금 해제 + executor owner release.
    const processed = await recoverTerminalUnsettledRuns(w.db, new Date(now.getTime() + 10 * MIN), 5 * MIN);
    expect(processed).toBeGreaterThanOrEqual(1);
    const settled = await fetchHeartbeatRun(w.db, run.id);
    expect(settled.settledAt).not.toBeNull();
    expect(settled.executorOwnerReleasedAt).not.toBeNull();
    const [issue] = await w.db.select().from(issues).where(eq(issues.id, seed.issue.id));
    expect(issue.executionRunId).toBeNull();
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();

    // 장부: 종결 전이 이벤트는 cleanup 경로에서 기록된다.
    const events = await w.db
      .select()
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.heartbeatRunId, run.id));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("S02: 미션 cancelled cleanup 도 completed-step 성공 증거는 건드리지 않는다", async () => {
    const seed = await seedMissionV1Run(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      mission: { status: "cancelled" },
      stepCompleted: true,
      run: {
        status: "succeeded",
        terminalOutcome: "succeeded",
        resultJson: { ok: true },
        finishedAt: new Date(Date.now() - 5 * MIN),
        settledAt: new Date(Date.now() - 5 * MIN),
        executorOwnerReleasedAt: new Date(Date.now() - 5 * MIN),
      },
    });
    const before = await fetchHeartbeatRun(w.db, seed.run.id);
    const now = new Date();
    const result = await runMissionTerminalCleanup(w.db, {
      companyId: w.companyId,
      missionId: seed.mission.id,
      status: "cancelled",
      now,
      completedAt: null,
      missionSnapshot: await missionRow(seed.mission.id),
    });
    expect(result.aborted).toBe(false);

    // 성공 run 은 byte-identical 유지 — 종결 cleanup 이 증거를 덮어쓰지 않는다.
    const after = await fetchHeartbeatRun(w.db, seed.run.id);
    expect(after.status).toBe("succeeded");
    expect(after.terminalOutcome).toBe("succeeded");
    expect(after.resultJson).toEqual({ ok: true });
    expect(after.settledAt?.getTime()).toBe(before.settledAt?.getTime());
    expect(after.finishedAt?.getTime()).toBe(before.finishedAt?.getTime());
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
  });
});
