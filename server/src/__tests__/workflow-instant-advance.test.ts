// server/src/__tests__/workflow-instant-advance.test.ts
//
// [목적] 하트비트 가속 v1.2 — instant-advance 모듈 계약 검증.
//   1) 게이트 off → executeWorkflowRun 호출 없음
//   2) 게이트 on → 요청 즉시 1회 진행(executeWorkflowRun 재사용)
//   3) 진행 중 중복 요청 → dirty 합치기(총 진행 ≤ 요청 수, 버림 0)
//   4) 진행 중 예외 → dirty 재진행 1회(실패는 로그만, 폴백=틱)
//   5) dirty 연쇄 상한 5회 초과 시 중단 + 이후 요청은 새 체인으로 재시작
//   6) heartbeat.ts 훅 삽입 지점 — 런 완료 처리 함수에 스파이를 쉽게 못 박는 구조라
//      모듈 수준 검증 + 소스 구조 검증(3개 종결 지점 모두 release 커밋 후 배치)으로 대체.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const { executeWorkflowRunMock } = vi.hoisted(() => ({
  executeWorkflowRunMock: vi.fn(),
}));

vi.mock("../services/workflow/workflow-run-execution.js", () => ({
  executeWorkflowRun: executeWorkflowRunMock,
}));

import {
  configureInstantWorkflowAdvanceDb,
  isInstantWorkflowAdvanceEnabled,
  requestInstantWorkflowAdvance,
  resetInstantWorkflowAdvanceForTests,
} from "../services/workflow/instant-advance.js";

const DUMMY_DB = {} as Db;
const GATE = "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 마이크로태스크 큐를 몇 번 비운다(then 체인 정산 대기). */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  executeWorkflowRunMock.mockReset();
  resetInstantWorkflowAdvanceForTests();
  configureInstantWorkflowAdvanceDb(DUMMY_DB);
  process.env[GATE] = "1";
});

afterEach(() => {
  delete process.env[GATE];
  configureInstantWorkflowAdvanceDb(null);
});

describe("instant-advance gate", () => {
  it("gate off (unset) → executeWorkflowRun never called", async () => {
    delete process.env[GATE];
    requestInstantWorkflowAdvance("wf-run-1");
    await flushMicrotasks();
    expect(executeWorkflowRunMock).not.toHaveBeenCalled();
  });

  it("gate values other than 1/true are off", async () => {
    for (const value of ["0", "false", "yes", ""]) {
      process.env[GATE] = value;
      expect(isInstantWorkflowAdvanceEnabled()).toBe(false);
    }
    requestInstantWorkflowAdvance("wf-run-1");
    await flushMicrotasks();
    expect(executeWorkflowRunMock).not.toHaveBeenCalled();
  });

  it("gate 1/true are on", () => {
    process.env[GATE] = "1";
    expect(isInstantWorkflowAdvanceEnabled()).toBe(true);
    process.env[GATE] = "true";
    expect(isInstantWorkflowAdvanceEnabled()).toBe(true);
  });

  it("request without configured db → no-op, no throw", async () => {
    configureInstantWorkflowAdvanceDb(null);
    expect(() => requestInstantWorkflowAdvance("wf-run-1")).not.toThrow();
    await flushMicrotasks();
    expect(executeWorkflowRunMock).not.toHaveBeenCalled();
  });
});

describe("instant-advance execution", () => {
  it("single request → exactly one immediate advance via executeWorkflowRun", async () => {
    executeWorkflowRunMock.mockResolvedValue({ kind: "settled" });
    requestInstantWorkflowAdvance("wf-run-2");
    // 즉시 시작(완료 대기 아님 — fire-and-forget): 호출은 동기 관점에서 이미 발생.
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowRunMock).toHaveBeenCalledWith(DUMMY_DB, "wf-run-2");
    await flushMicrotasks();
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(1);
  });

  it("after settle, a new request starts a fresh advance (inflight cleanup)", async () => {
    executeWorkflowRunMock.mockResolvedValue({});
    requestInstantWorkflowAdvance("wf-run-3");
    await flushMicrotasks();
    requestInstantWorkflowAdvance("wf-run-3");
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(2);
    await flushMicrotasks();
  });

  it("duplicate requests during flight coalesce into dirty — total advances ≤ requests, none dropped", async () => {
    const gate = deferred();
    executeWorkflowRunMock.mockImplementation(() => gate.promise);
    requestInstantWorkflowAdvance("wf-run-4"); // advance #1 starts
    requestInstantWorkflowAdvance("wf-run-4"); // dirty
    requestInstantWorkflowAdvance("wf-run-4"); // dirty (합쳐짐)
    requestInstantWorkflowAdvance("wf-run-4"); // dirty (합쳐짐)
    await flushMicrotasks();
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flushMicrotasks();
    // dirty 보증: 요청이 버려지지 않았다면 정확히 1회의 재진행이 발생한다(총 2 ≤ 요청 4).
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(2);
    await flushMicrotasks();
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(2);
  });

  it("advance exception during flight → dirty re-run once, failure is logged not thrown", async () => {
    const first = deferred();
    let calls = 0;
    executeWorkflowRunMock.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({});
    });
    requestInstantWorkflowAdvance("wf-run-5"); // advance #1 (will reject)
    requestInstantWorkflowAdvance("wf-run-5"); // dirty
    expect(() => first.reject(new Error("boom"))).not.toThrow();
    await flushMicrotasks();
    expect(calls).toBe(2); // dirty 재진행 1회
    await flushMicrotasks();
    expect(calls).toBe(2); // 더 이상 연쇄 없음
  });

  it("dirty chain stops at the 5-advance cap and later requests start a fresh chain", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    executeWorkflowRunMock.mockImplementation(() => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    });
    const id = "wf-run-6";
    requestInstantWorkflowAdvance(id); // advance 1 (chainCount=1)
    // 진행 중 dirty → 연쇄로 advance 5까지 도달한다.
    for (let round = 0; round < 4; round += 1) {
      requestInstantWorkflowAdvance(id); // 진행 중 요청 → dirty
      gates[round]!.resolve(); // 현재 advance 종료 → dirty 체인 발화
      await flushMicrotasks(); // 다음 advance 시작(신규 gate 생성, dirty 해제)
    }
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(5);
    expect(gates).toHaveLength(5);
    requestInstantWorkflowAdvance(id); // advance 5 진행 중 dirty
    gates[4]!.resolve(); // settle → 6회째는 상한 초과 → 중단·경고
    await flushMicrotasks(20);
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(5);
    expect(gates).toHaveLength(5);
    // 상한 후 모듈 상태 정리 확인: 새 요청은 새 체인(카운터 초기화)으로 시작한다.
    requestInstantWorkflowAdvance(id);
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(6);
    expect(gates).toHaveLength(6);
    gates[5]!.resolve();
    await flushMicrotasks();
    expect(executeWorkflowRunMock).toHaveBeenCalledTimes(6);
  });
});

describe("instant-advance heartbeat hook placement (indirect, structural)", () => {
  const heartbeatPath = fileURLToPath(
    new URL("../services/heartbeat.ts", import.meta.url),
  );

  it("hook fires from exactly 3 terminal finalization sites, each right after issue release commit", () => {
    const source = readFileSync(heartbeatPath, "utf8");
    const callLines = source.match(/^[ \t]*fireInstantWorkflowAdvanceForTerminalRun\(/gm) ?? [];
    expect(callLines).toHaveLength(3);
    // 각 훅 호출 직전(300자 내)에 releaseIssueExecutionAndPromote 커밋 호출이 있어야 한다.
    const positions: number[] = [];
    let cursor = source.indexOf("fireInstantWorkflowAdvanceForTerminalRun(");
    while (cursor !== -1) {
      positions.push(cursor);
      cursor = source.indexOf("fireInstantWorkflowAdvanceForTerminalRun(", cursor + 1);
    }
    const callPositions = positions.filter((pos) => {
      const lineStart = source.lastIndexOf("\n", pos) + 1;
      return /^[ \t]*$/.test(source.slice(lineStart, pos));
    });
    expect(callPositions).toHaveLength(3);
    for (const pos of callPositions) {
      const preceding = source.slice(Math.max(0, pos - 400), pos);
      expect(preceding.includes("releaseIssueExecutionAndPromote(")).toBe(true);
    }
  });

  it("heartbeatService wires the db into the module (configureInstantWorkflowAdvanceDb)", () => {
    const source = readFileSync(heartbeatPath, "utf8");
    expect(source).toContain("configureInstantWorkflowAdvanceDb(db);");
    // 팩토리 본문 안(heartbeatService 정의 이후)에서 호출되어야 한다.
    const factoryAt = source.indexOf("export function heartbeatService(db: Db) {");
    const wiringAt = source.indexOf("configureInstantWorkflowAdvanceDb(db);");
    expect(factoryAt).toBeGreaterThan(-1);
    expect(wiringAt).toBeGreaterThan(factoryAt);
  });
});
