import { describe, expect, it } from "vitest";
import { appendAttempt, latestAttemptVerdict, readAttempts } from "../services/workflow/control-flow/verdict-store.js";
import { STEP_ITERATION_ATTEMPTS_KEY } from "../services/workflow/control-flow/types.js";
import type { StepIterationAttempt } from "../services/workflow/control-flow/types.js";

/**
 * [목적] P4 verdict-store 단위 테스트(순수, DB/Date 없음).
 *   step_run.metadata.attempts[] 에 verdict/결함을 persist — issue 리셋에도 verdict 이력이 남게 한다.
 */

function attempt(iteration: number, verdict: StepIterationAttempt["verdict"] = null): StepIterationAttempt {
  return { iteration, verdict, completedAt: null };
}

describe("readAttempts", () => {
  it("metadata 없음/비객체 → 빈 배열", () => {
    expect(readAttempts(undefined)).toEqual([]);
    expect(readAttempts(null)).toEqual([]);
    expect(readAttempts("nope")).toEqual([]);
    expect(readAttempts([])).toEqual([]);
    expect(readAttempts({})).toEqual([]);
  });

  it("attempts[] 복원", () => {
    const metadata = {
      [STEP_ITERATION_ATTEMPTS_KEY]: [
        { iteration: 0, verdict: "request_changes", failureReasons: ["x"], completedAt: "2026-06-01T00:00:00.000Z" },
        { iteration: 1, verdict: "pass", completedAt: null },
      ],
    };
    expect(readAttempts(metadata)).toHaveLength(2);
    expect(readAttempts(metadata)[0]!.verdict).toBe("request_changes");
    expect(readAttempts(metadata)[1]!.verdict).toBe("pass");
  });

  it("잘못된 원소는 drop(iteration 누락 / verdict 불일치 / completedAt 타입 오류)", () => {
    const metadata = {
      [STEP_ITERATION_ATTEMPTS_KEY]: [
        { iteration: 0, verdict: "pass", completedAt: null }, // ok
        { verdict: "pass", completedAt: null }, // iteration 누락 → drop
        { iteration: 1, verdict: "weird", completedAt: null }, // verdict 불일치 → drop
        { iteration: 2, verdict: "pass", completedAt: 123 }, // completedAt 타입 오류 → drop
        { iteration: 3, verdict: null, completedAt: null }, // ok (verdict null 허용)
      ],
    };
    const result = readAttempts(metadata);
    expect(result.map((entry) => entry.iteration)).toEqual([0, 3]);
  });

  it("attempts 가 배열이 아니면 빈 배열", () => {
    expect(readAttempts({ [STEP_ITERATION_ATTEMPTS_KEY]: "nope" })).toEqual([]);
    expect(readAttempts({ [STEP_ITERATION_ATTEMPTS_KEY]: { iteration: 0 } })).toEqual([]);
  });
});

describe("appendAttempt", () => {
  it("빈 metadata 에 append → attempts[] 생성", () => {
    const result = appendAttempt({}, attempt(0, "request_changes"));
    expect(result[STEP_ITERATION_ATTEMPTS_KEY]).toEqual([attempt(0, "request_changes")]);
  });

  it("기존 attempts 에 순서대로 append", () => {
    const after0 = appendAttempt({}, attempt(0, "request_changes"));
    const after1 = appendAttempt(after0, attempt(1, "pass"));
    expect(readAttempts(after1).map((entry) => entry.iteration)).toEqual([0, 1]);
    expect(latestAttemptVerdict(after1)).toBe("pass");
  });

  it("다른 metadata 키는 보존(executionControls / controlFlowSkipped sentinel)", () => {
    const base = {
      executionControls: { concurrencyLimit: 2 },
      controlFlowSkipped: true,
      [STEP_ITERATION_ATTEMPTS_KEY]: [attempt(0, "request_changes")],
    };
    const result = appendAttempt(base, attempt(1, "pass"));
    // 원본 불변
    expect(readAttempts(base)).toHaveLength(1);
    // 결과: 다른 키 보존 + attempts append
    expect(result.executionControls).toEqual({ concurrencyLimit: 2 });
    expect(result.controlFlowSkipped).toBe(true);
    expect(readAttempts(result).map((entry) => entry.iteration)).toEqual([0, 1]);
  });
});

describe("latestAttemptVerdict", () => {
  it("attempts 없음 → null", () => {
    expect(latestAttemptVerdict({})).toBeNull();
    expect(latestAttemptVerdict(undefined)).toBeNull();
  });

  it("마지막 attempt 의 verdict", () => {
    expect(latestAttemptVerdict({ [STEP_ITERATION_ATTEMPTS_KEY]: [attempt(0, "request_changes")] }))
      .toBe("request_changes");
    expect(
      latestAttemptVerdict({
        [STEP_ITERATION_ATTEMPTS_KEY]: [attempt(0, "request_changes"), attempt(1, "pass")],
      }),
    ).toBe("pass");
  });

  it("마지막 attempt 의 verdict 가 null/undefined 면 null", () => {
    expect(latestAttemptVerdict({ [STEP_ITERATION_ATTEMPTS_KEY]: [attempt(0, null)] })).toBeNull();
    expect(latestAttemptVerdict({ [STEP_ITERATION_ATTEMPTS_KEY]: [attempt(0, undefined)] })).toBeNull();
  });
});
