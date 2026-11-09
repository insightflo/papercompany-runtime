import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { STORED_OUTPUT_TRUNCATE_THRESHOLD } from "../services/heartbeat-run-summary.js";
import { runHeartbeatRunOutputRetention } from "../services/heartbeat-run-output-retention.js";
import {
  DAY_MS,
  describeRetentionDb,
  noBackup,
  startRetentionTestDb,
  type RetentionTestDb,
} from "./helpers/heartbeat-run-output-retention-fixture.js";

describeRetentionDb("runHeartbeatRunOutputRetention hardening (embedded postgres)", () => {
  let fx: RetentionTestDb;

  beforeAll(async () => {
    fx = await startRetentionTestDb();
  }, 60_000);

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("re-checks backup status before every batch and aborts mid-pass when a backup starts", async () => {
    const oversized = "j".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const base = Date.now() - 8 * DAY_MS;
    const firstId = await fx.seedRun({ createdAt: new Date(base), resultJson: { stdout: oversized } });
    const secondId = await fx.seedRun({ createdAt: new Date(base + 1_000), resultJson: { stdout: oversized } });
    const thirdId = await fx.seedRun({ createdAt: new Date(base + 2_000), resultJson: { stdout: oversized } });

    // 두 번째 배치 확인에서 백업 시작이 관측되는 시나리오(호출 순서로 제어).
    let checks = 0;
    const result = await runHeartbeatRunOutputRetention(fx.db, {
      retentionDays: 7,
      batchRows: 2,
      isBackupActive: async () => {
        checks += 1;
        return checks >= 2;
      },
    });

    expect(checks).toBe(2);
    expect(result.skipped).toBe("backup");
    expect(result.batches).toBe(1);
    expect(result.rowsTruncated).toBe(2);
    // 선별은 created_at 오름차순이므로 배치 1(2행)이 가장 오래된 2행을 절단하고,
    // 두 번째 배치 직전에 중단돼 가장 최근 행(thirdId)만 원문으로 남는다.
    const stillOriginal = (await Promise.all([firstId, secondId, thirdId].map(fx.fetchRun)))
      .filter((row) => row.resultJson?.stdout === oversized);
    expect(stillOriginal).toHaveLength(1);
    expect(stillOriginal[0].id).toBe(thirdId);
  });

  it("does not overwrite a row rewritten between selection and update", async () => {
    const original = "k".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const id = await fx.seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stdout: original },
    });
    const rewritten = { stdout: "fresh output written after selection" };
    // 선별 후 갱신 직전에 다른 경로가 같은 행의 result_json 을 덮어쓴 상황을
    // 재현한다: execute 호출 순서가 선별 SELECT → 배치 UPDATE 이므로 두 번째
    // execute 직전에 재기록을 먼저 확정한 뒤 원래 UPDATE 를 진행시킨다.
    let calls = 0;
    let intercepted = false;
    const racing = new Proxy(fx.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "execute") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          calls += 1;
          if (!intercepted && calls === 2) {
            intercepted = true;
            await (target.execute as (q: ReturnType<typeof sql>) => Promise<unknown>)(
              sql`UPDATE heartbeat_runs SET result_json = ${JSON.stringify(rewritten)}::jsonb WHERE id = ${id}`,
            );
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as Db;

    await runHeartbeatRunOutputRetention(racing, { retentionDays: 7, isBackupActive: noBackup });

    expect(intercepted).toBe(true);
    const row = await fx.fetchRun(id);
    // 캡된 구스냅샷으로 덮어쓰지 않고 재기록된 값이 보존된다(조건부 UPDATE).
    expect(row.resultJson).toEqual(rewritten);
  });
});
