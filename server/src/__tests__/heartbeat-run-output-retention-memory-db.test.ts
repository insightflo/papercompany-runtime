import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { runHeartbeatRunOutputRetention } from "../services/heartbeat-run-output-retention.js";
import {
  DAY_MS,
  describeRetentionDb,
  noBackup,
  startRetentionTestDb,
  type RetentionTestDb,
} from "./helpers/heartbeat-run-output-retention-fixture.js";

// [OOM 재현 2026-11-09] A1 에서 첫 스윽이 V8 힙 ~2GB 로 죽은 결함의 회귀 가드.
//   구 구현은 후보 선별 SELECT 가 result_json 전체를 최대 200행분 Node 로
//   가져와 파싱했고(행당 수 MB → 배치당 수백 MB~GB), 배치 처리가 끝날 때까지
//   candidates 배열이 전부 붙들고 있었다. 신 구현은 id·md5·바이트 길이만 가져오고
//   절단은 DB 안의 UPDATE 한 문이 수행하므로 Node 힙 증가가 상한 아래여야 한다.
//   데이터 규모는 브리프의 5~20MB×수백 행을 CI 가능한 4MB×40행(160MB)으로
//   축소했다 — 구 구현이라도 파싱+보유로 100MB 를 넉넉히 넘는 크기다.
const HEAP_GROWTH_LIMIT_BYTES = 100 * 1024 * 1024;

setFlagsFromString("--expose-gc");
// Node v24 ESM 에서 --expose-gc 는 새 V8 컨텍스트에만 gc 를 바인딩한다 —
// globalThis.gc 는 undefined 라 runInNewContext 로 실제 함수를 얻는다.
const gc = runInNewContext("gc") as (() => void) | undefined;

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

describeRetentionDb("runHeartbeatRunOutputRetention memory bound (embedded postgres)", () => {
  let fx: RetentionTestDb;

  beforeAll(async () => {
    fx = await startRetentionTestDb();
  }, 60_000);

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("keeps Node heap growth under 100MB while truncating 160MB of run outputs", async () => {
    const rowCount = 40;
    const bytesPerRow = 4 * 1024 * 1024;
    const stdout = "x".repeat(bytesPerRow);
    const base = Date.now() - 9 * DAY_MS;
    for (let i = 0; i < rowCount; i += 1) {
      await fx.seedRun({
        createdAt: new Date(base + i * 1_000),
        resultJson: { stdout, idx: i },
      });
    }

    gc?.();
    const baselineHeap = heapUsed();
    let peakHeap = baselineHeap;
    // db 호출이 끝난 직후마다 힙을 찍는다. 구 구현에서는 선별 SELECT 가
    // 반환된 시점에 배치 전체의 result_json 이 파싱·보유 상태라 이 표본에서
    // 피크가 잡힌다.
    // execute 만 감싼다 — 선별·배치 UPDATE 모두 이 경로를 지나고, update 는
    // drizzle 빌더(thenable 체인)라 감싸면 계약이 깨진다.
    const metered = new Proxy(fx.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "execute") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          peakHeap = Math.max(peakHeap, heapUsed());
          return out;
        };
      },
    }) as Db;

    const result = await runHeartbeatRunOutputRetention(metered, {
      retentionDays: 7,
      isBackupActive: noBackup,
    });

    peakHeap = Math.max(peakHeap, heapUsed());
    expect(result.skipped).toBeNull();
    expect(result.rowsTruncated).toBe(rowCount);
    expect(peakHeap - baselineHeap).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
  }, 120_000);
});
