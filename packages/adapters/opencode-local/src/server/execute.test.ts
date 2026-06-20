import { describe, expect, it } from "vitest";
import { isOpenCodeProviderOverloaded } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/**
 * [목적] opencode_local hang 방어(opencode→z.ai GLM no-response)의 결정적 검증.
 *   (1) overload 감지기가 z.ai GLM 529 / rate-limit / overload 를 정확히 잡고 정상 출력은 놓치는지,
 *   (2) runChildProcess 가 무출력 자식(GLM hang 과 동일)을 idleTimeoutSec 안에 실제로 kill 하는지,
 *   (3) hard timeoutSec 도 출력은 있으나 종료 않는 자식을 절단하는지.
 *   이 kill 메커니즘을 opencode execute 가 idleTimeoutSec/timeoutSec 과 함께 사용한다.
 */
const noop = async () => {};

describe("isOpenCodeProviderOverloaded (opencode provider overload detector)", () => {
  it("detects z.ai GLM 529 / overload / rate-limit signals in error text", () => {
    expect(isOpenCodeProviderOverloaded({ errorMessage: "zai returned 529 overloaded" }, "")).toBe(true);
    expect(isOpenCodeProviderOverloaded({ errorMessage: "status 529: server overloaded" }, "")).toBe(true);
    expect(isOpenCodeProviderOverloaded({ errorMessage: "429 Too Many Requests" }, "")).toBe(true);
    expect(isOpenCodeProviderOverloaded({ errorMessage: "rate limit exceeded" }, "")).toBe(true);
    expect(isOpenCodeProviderOverloaded({ errorMessage: "service unavailable" }, "")).toBe(true);
    expect(isOpenCodeProviderOverloaded({ errorMessage: null }, "Error: 503 service unavailable")).toBe(true);
  });

  it("does not treat normal output / non-overload errors as overload", () => {
    expect(isOpenCodeProviderOverloaded({ errorMessage: "unknown session abc" }, "")).toBe(false);
    expect(isOpenCodeProviderOverloaded({ errorMessage: "tool failed: exit code 1" }, "")).toBe(false);
    // 토큰 카운트 등 무해한 500 숫자는 overload 로 오판하지 않는다(500 은 status 문맥에서만).
    expect(isOpenCodeProviderOverloaded({ errorMessage: "used 500 tokens" }, "")).toBe(false);
    expect(isOpenCodeProviderOverloaded({ errorMessage: null }, "")).toBe(false);
  });
});

describe("opencode_local hang protection via runChildProcess (idle/hard timeout kill)", () => {
  it("kills a no-output child (GLM no-response equivalent) via idleTimeoutSec and reports timedOut", async () => {
    // 60s 동안 아무 출력 없이 대기 = z.ai GLM no-response hang 조건과 동일.
    let spawnedPid = 0;
    const result = await runChildProcess("test-idle-run", "node", ["-e", "setInterval(()=>{},60000)"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 30, // hard backstop — idle 가 먼저 걸려야 함
      idleTimeoutSec: 1, // 1s 무출력 → kill
      graceSec: 1,
      onLog: noop,
      onSpawn: async (meta) => {
        spawnedPid = meta.pid;
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.idleTimedOut).toBe(true);
    // 자식이 실제로 회수됐는지: 잡은 PID 가 더 이상 살아있지 않아야 한다(orphan 방어).
    if (spawnedPid > 0) {
      expect(() => process.kill(spawnedPid, 0)).toThrow();
    }
  }, 15000);

  it("hard timeoutSec cuts a continuously-outputting child that never exits", async () => {
    // stdout 은 계속 뿜지만 종료 안 함 → idle 안 걸리고 hard timeout 이 절단.
    let spawnedPid = 0;
    const result = await runChildProcess(
      "test-hard-run",
      "node",
      ["-e", "setInterval(()=>process.stdout.write('.'),200)"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1, // hard 절단
        idleTimeoutSec: 30, // 출력 있으므로 idle 안 걸림
        graceSec: 1,
        onLog: noop,
        onSpawn: async (meta) => {
          spawnedPid = meta.pid;
        },
      },
    );

    expect(result.timedOut).toBe(true);
    if (spawnedPid > 0) {
      expect(() => process.kill(spawnedPid, 0)).toThrow();
    }
  }, 15000);
});
