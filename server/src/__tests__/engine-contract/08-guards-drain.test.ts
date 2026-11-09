// engine-contract S17·S18 — 프로세스 경계 계약 (#685·#686 회귀).
// S17: run-status 쓰기 초크포인트 가드 스크립트가 위반 없이 통과하고 self-test 가드도 감지한다.
// S18: shadow loop drain 은 진행 중 틱을 기다리되 유한 시간 안에 돌아오고 stop 후 새 틱은 없다.
// 이 파일은 DB 가 필요 없는 계약(프로세스·스크립트 경계) — 순수함수/프로세스 표면 검증.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, describe } from "vitest";
import { createBoundedShadowLoop } from "../../services/judgment/shadow-loop-runner.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const guardScript = `${repoRoot}scripts/check-run-status-write-chokepoint.mjs`;

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const emptyPass = { scanned: 0, processed: 0, recorded: 0, skipped: 0 };

describe("engine-contract S17/S18 — chokepoint guard & bounded drain (#685/#686)", () => {
  it("S17: run-status 쓰기 초크포인트 가드 — 정상 스캔 통과 + self-test 가 우회 사례를 감지한다", () => {
    const clean = execFileSync(process.execPath, [guardScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(clean).toMatch(/OK|no violation|passed/i);

    // self-test 는 합성 우회 사례로 가드의 탐지 능력 자체를 검증한다.
    const selfTest = execFileSync(process.execPath, [guardScript, "--self-test"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(selfTest).toMatch(/OK|self-test|passed/i);
  }, 60_000);

  it("S18: bounded drain — 진행 중 틱을 기다리고, 응답 없는 틱도 drainTimeout 안에 돌아온다", async () => {
    // (a) 정상 배출: in-flight 틱이 끝나면 drain 이 완료되고 stop 후 새 자동 틱은 없다.
    const started = deferred();
    const release = deferred();
    let passCalls = 0;
    const loop = createBoundedShadowLoop({
      name: "engine-contract-shadow",
      seededLogMessage: "seeded",
      startLogContext: {},
      intervalMs: 30,
      drainTimeoutMs: 5_000,
      seedOnce: async () => ({ seeded: 0, companies: 0 }),
      runPass: async () => {
        passCalls += 1;
        started.resolve();
        await release.promise;
        return emptyPass;
      },
    });
    try {
      loop.start();
      await started.promise;
      loop.stop();
      expect(loop.getState().running).toBe(false);

      let drained = false;
      const draining = loop.drain().then(() => { drained = true; });
      // in-flight 틱이 끝나기 전에는 drain 이 완료되지 않는다.
      await new Promise((r) => setTimeout(r, 40));
      expect(drained).toBe(false);

      release.resolve();
      await draining;
      expect(drained).toBe(true);
      expect(loop.getState().tickCount).toBe(1);

      // stop 이후에는 interval 틱이 더 이상 발사되지 않는다.
      await new Promise((r) => setTimeout(r, 90));
      expect(passCalls).toBe(1);
    } finally {
      release.resolve();
      loop.stop();
    }

    // (b) 유한 상한: 응답하지 않는 틱이 있어도 drain 은 drainTimeoutMs 안에 돌아온다.
    const stuckStarted = deferred();
    const never = new Promise<void>(() => {});
    const stuckLoop = createBoundedShadowLoop({
      name: "engine-contract-shadow-stuck",
      seededLogMessage: "seeded",
      startLogContext: {},
      intervalMs: 60_000,
      drainTimeoutMs: 150,
      seedOnce: async () => ({ seeded: 0, companies: 0 }),
      runPass: async () => {
        stuckStarted.resolve();
        await never;
        return emptyPass;
      },
    });
    try {
      stuckLoop.start();
      await stuckStarted.promise;
      const t0 = Date.now();
      await stuckLoop.drain();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(10_000);
      expect(stuckLoop.getState().running).toBe(false);
    } finally {
      stuckLoop.stop();
    }
  }, 30_000);
});
