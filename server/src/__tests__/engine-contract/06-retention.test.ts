// engine-contract S13·S14·S15 — heartbeat run 출력 보존 절단 계약 (#688·#689 회귀).
// seed: 순수 DB 행 → entry: runHeartbeatRunOutputRetention → assert: heartbeat_runs.result_json 최종 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { runHeartbeatRunOutputRetention } from "../../services/heartbeat-run-output-retention.js";
import {
  MIN,
  describeEP,
  fetchHeartbeatRun,
  seedHeartbeatRun,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

const DAY = 24 * 60 * MIN;
const BIG_STDOUT = "x".repeat(80_000);
const OLD = new Date(Date.now() - 10 * DAY);

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-retention-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

function stdoutOf(resultJson: unknown): string {
  return String((resultJson as Record<string, unknown> | null)?.stdout ?? "");
}

async function seedRetentionCandidate() {
  return seedHeartbeatRun(w.db, {
    companyId: w.companyId,
    agentId: w.agentId,
    status: "succeeded",
    terminalOutcome: "succeeded",
    resultJson: { stdout: BIG_STDOUT, summary: "done" },
    createdAt: OLD,
    finishedAt: OLD,
    settledAt: OLD,
  });
}

describeEP("engine-contract S13/S14/S15 — run output retention (#688/#689)", () => {
  it("S13: 보존일 경과 종결 run 의 큰 출력만 절단하고 최근·진행·미정산 행은 건드리지 않는다", async () => {
    const stale = await seedRetentionCandidate();
    const fresh = await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, status: "succeeded",
      resultJson: { stdout: BIG_STDOUT }, finishedAt: new Date(), settledAt: new Date(),
    });
    const running = await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, status: "running",
      resultJson: { stdout: BIG_STDOUT }, createdAt: OLD,
    });
    const unsettledV1 = await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, status: "failed", terminalOutcome: "failed",
      finalizationVersion: 1, settledAt: null,
      resultJson: { stdout: BIG_STDOUT }, createdAt: OLD, finishedAt: OLD,
    });
    const updatedAtBefore = stale.updatedAt;

    const result = await runHeartbeatRunOutputRetention(w.db, {
      retentionDays: 7,
      isBackupActive: async () => false,
    });
    expect(result.skipped).toBeNull();
    expect(result.rowsTruncated).toBe(1);

    // 절단 계약: result_json 만 바뀌고 truncation 표식은 신규 저장 계약과 동일.
    const truncated = await fetchHeartbeatRun(w.db, stale.id);
    const stdout = stdoutOf(truncated.resultJson);
    expect(stdout.length).toBeLessThan(70_000 + 500);
    expect(stdout).toContain("truncated");
    expect((truncated.resultJson as Record<string, unknown>).summary).toBe("done");
    expect(truncated.status).toBe("succeeded");
    expect(truncated.updatedAt?.getTime()).toBe(updatedAtBefore?.getTime());

    // 비대상 행은 byte-identical.
    expect(stdoutOf((await fetchHeartbeatRun(w.db, fresh.id)).resultJson)).toBe(BIG_STDOUT);
    expect(stdoutOf((await fetchHeartbeatRun(w.db, running.id)).resultJson)).toBe(BIG_STDOUT);
    expect(stdoutOf((await fetchHeartbeatRun(w.db, unsettledV1.id)).resultJson)).toBe(BIG_STDOUT);

    // 멱등: 두 번째 패스는 0행.
    const second = await runHeartbeatRunOutputRetention(w.db, {
      retentionDays: 7,
      isBackupActive: async () => false,
    });
    expect(second.rowsTruncated).toBe(0);
  });

  it("S14: 백업 활성이면 쓰지 않고, 패스 도중 시작된 백업은 배치 경계에서 중단시킨다", async () => {
    // (a) 패스 시작 시점 백업 활성 — 전면 skip, 0행 쓰기.
    const a = await seedRetentionCandidate();
    const skipped = await runHeartbeatRunOutputRetention(w.db, {
      retentionDays: 7,
      isBackupActive: async () => true,
    });
    expect(skipped.skipped).toBe("backup");
    expect(skipped.rowsTruncated).toBe(0);
    expect(skipped.batches).toBe(0);
    expect(stdoutOf((await fetchHeartbeatRun(w.db, a.id)).resultJson)).toBe(BIG_STDOUT);

    // (b) 첫 배치 후 백업 시작 — 남은 행은 다음 사이클로 미루고 즉시 중단.
    const b1 = await seedRetentionCandidate();
    const b2 = await seedRetentionCandidate();
    let checks = 0;
    const midPass = await runHeartbeatRunOutputRetention(w.db, {
      retentionDays: 7,
      batchRows: 1,
      isBackupActive: async () => (++checks >= 2),
    });
    expect(midPass.skipped).toBe("backup");
    expect(midPass.batches).toBe(1);
    expect(midPass.rowsTruncated).toBe(1);
    const rows = [a.id, b1.id, b2.id];
    const states = await Promise.all(rows.map(async (id) => stdoutOf((await fetchHeartbeatRun(w.db, id)).resultJson)));
    const truncatedCount = states.filter((s) => s !== BIG_STDOUT).length;
    expect(truncatedCount).toBe(1);
  });

  it("S15: 선별→갱신 사이에 재기록된 행은 CAS 로 건너뛰어 덮어쓰지 않는다", async () => {
    // 앞선 시나리오의 잔여 후보를 먼저 배수해 이 시험의 대상만 남긴다.
    await runHeartbeatRunOutputRetention(w.db, { retentionDays: 7, isBackupActive: async () => false });
    const candidate = await seedRetentionCandidate();
    const rewritten = { stdout: "y".repeat(80_000), marker: "concurrent-writer" };
    const realDb = w.db;
    let rewrote = false;
    // 선별 SELECT(db.execute)가 돌아온 직후 — 즉 후보 행의 해시가 이미 읽힌 뒤 — 다른 writer 가
    // 같은 행을 다시 쓰는 경합을 재현한다. 조건부 UPDATE 는 stale 해시를 감지해 건너뛰어야 한다.
    const proxyDb = new Proxy(realDb, {
      get(target, prop, recv) {
        if (prop === "execute") {
          return async (...args: unknown[]) => {
            const result = await (Reflect.get(target, prop, recv) as (...a: unknown[]) => Promise<unknown>)
              .apply(target, args);
            if (!rewrote) {
              rewrote = true;
              await realDb
                .update(heartbeatRuns)
                .set({ resultJson: rewritten })
                .where(eq(heartbeatRuns.id, candidate.id));
            }
            return result;
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    const result = await runHeartbeatRunOutputRetention(proxyDb, {
      retentionDays: 7,
      isBackupActive: async () => false,
    });
    expect(rewrote).toBe(true);
    expect(result.skipped).toBeNull();
    expect(result.rowsTruncated).toBe(0);
    expect(result.batches).toBeGreaterThanOrEqual(1);
    // 재기록된 값은 절단 없이 그대로 보존된다.
    expect((await fetchHeartbeatRun(w.db, candidate.id)).resultJson).toEqual(rewritten);
  });
});
