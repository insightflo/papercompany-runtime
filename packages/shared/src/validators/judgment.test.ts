import { describe, expect, it } from "vitest";
import {
  judgmentAnswerSchema,
  judgmentCallOutcomeSchema,
  judgmentDefinitionSnapshotSchema,
  judgmentQuestionSchema,
  judgmentQuestionTypeSchema,
} from "./judgment.js";

const validQuestion = {
  name: "plan_quality",
  type: "choice",
  instructions: "계획이 실행 가능한지 고르세요",
  criteria: "예산/일정/담당자 명시 여부",
};

const validSnapshot = {
  description: "PLAN-QA 사전 스크리닝",
  stateAssembly: { kind: "inline-ref", notes: "mission plan 본문을 state로 전달" },
  questions: [validQuestion],
  policy: { notes: "임계값 미달이면 관측만", thresholds: { minConfidence: 0.6 } },
};

describe("judgmentQuestionTypeSchema", () => {
  it("choice/score/noul 만 허용한다", () => {
    expect(judgmentQuestionTypeSchema.parse("choice")).toBe("choice");
    expect(judgmentQuestionTypeSchema.parse("score")).toBe("score");
    expect(judgmentQuestionTypeSchema.parse("noul")).toBe("noul");
    expect(judgmentQuestionTypeSchema.safeParse("essay").success).toBe(false);
  });
});

describe("judgmentQuestionSchema", () => {
  it("유효한 질문을 통과시킨다 (criteria 생략 가능)", () => {
    expect(judgmentQuestionSchema.safeParse(validQuestion).success).toBe(true);
    expect(
      judgmentQuestionSchema.safeParse({ name: "q", type: "score", instructions: "점수" }).success,
    ).toBe(true);
  });

  it("빈 name/알 수 없는 type/빈 instructions 를 거부한다", () => {
    expect(judgmentQuestionSchema.safeParse({ ...validQuestion, name: "" }).success).toBe(false);
    expect(judgmentQuestionSchema.safeParse({ ...validQuestion, type: "essay" }).success).toBe(false);
    expect(judgmentQuestionSchema.safeParse({ ...validQuestion, instructions: "" }).success).toBe(
      false,
    );
  });
});

describe("judgmentDefinitionSnapshotSchema", () => {
  it("유효한 정의 스냅샷을 통과시킨다", () => {
    expect(judgmentDefinitionSnapshotSchema.safeParse(validSnapshot).success).toBe(true);
  });

  it("questions 가 비면 거부한다", () => {
    expect(
      judgmentDefinitionSnapshotSchema.safeParse({ ...validSnapshot, questions: [] }).success,
    ).toBe(false);
  });

  it("stateAssembly.kind 는 inline-ref 만 허용한다", () => {
    expect(
      judgmentDefinitionSnapshotSchema.safeParse({
        ...validSnapshot,
        stateAssembly: { kind: "remote-fetch", notes: "x" },
      }).success,
    ).toBe(false);
  });

  it("thresholds 값은 숫자여야 한다", () => {
    expect(
      judgmentDefinitionSnapshotSchema.safeParse({
        ...validSnapshot,
        policy: { notes: "n", thresholds: { min: "0.6" } },
      }).success,
    ).toBe(false);
  });
});

describe("judgmentCallOutcomeSchema", () => {
  it("executed/observed/error/disabled 만 허용한다", () => {
    for (const outcome of ["executed", "observed", "error", "disabled"]) {
      expect(judgmentCallOutcomeSchema.parse(outcome)).toBe(outcome);
    }
    expect(judgmentCallOutcomeSchema.safeParse("skipped").success).toBe(false);
  });
});

describe("judgmentAnswerSchema", () => {
  it("choice 답변(문자열 값+확률+신뢰도)을 통과시킨다", () => {
    expect(
      judgmentAnswerSchema.safeParse({
        name: "plan_quality",
        type: "choice",
        value: "pass",
        probabilities: { pass: 0.8, fail: 0.2 },
        confidence: 0.8,
      }).success,
    ).toBe(true);
  });

  it("score 답변(숫자 값)과 noul 답변(null 값)을 통과시킨다", () => {
    expect(
      judgmentAnswerSchema.safeParse({ name: "risk", type: "score", value: 7 }).success,
    ).toBe(true);
    expect(
      judgmentAnswerSchema.safeParse({ name: "memo", type: "noul", value: null }).success,
    ).toBe(true);
  });

  it("값 타입이 문자열/숫자/null 이 아니면 거부한다", () => {
    expect(
      judgmentAnswerSchema.safeParse({ name: "q", type: "choice", value: { x: 1 } }).success,
    ).toBe(false);
  });
});
