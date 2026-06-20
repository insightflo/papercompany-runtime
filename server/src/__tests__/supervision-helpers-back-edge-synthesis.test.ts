import { describe, expect, it } from "vitest";
import {
  QA_REWORK_DEFAULT_MAX_ITERATIONS,
  synthesizeQaReworkBackEdge,
  type BackEdgeCapableStep,
} from "../services/missions/supervision-helpers.js";
import { hasDisallowedCycle } from "../services/workflow/control-flow/cycle-validator.js";
import { normalizeConditionalEdges } from "../services/workflow/control-flow/types.js";

/**
 * [목적] P5 PAQO 미션 QA → producer rework back-edge 자동 합성(synthesizeQaReworkBackEdge) 단위 테스트.
 *   순수 함수 — DB 없이 step 배열 변환만 검증. producer 식별은 resolveProducerStepIdFromDag 에 위임.
 */

type Step = BackEdgeCapableStep;

function action(id: string, dependencies: string[] = [], conditionalDependencies?: Step["conditionalDependencies"]): Step {
  return { id, dependencies, ...(conditionalDependencies ? { conditionalDependencies } : {}) };
}
function qa(id: string, dependencies: string[]): Step {
  return { id, dependencies };
}

function backEdge(producerId: string, qaId: string, maxIterations = QA_REWORK_DEFAULT_MAX_ITERATIONS) {
  const steps = [action(producerId), qa(qaId, [producerId])];
  return synthesizeQaReworkBackEdge(steps, qaId, maxIterations);
}

describe("synthesizeQaReworkBackEdge — 기본 합성", () => {
  it("단일 producer → QA back-edge 를 producer 의 conditionalDependencies 에 추가(forward deps 불변)", () => {
    const before = [action("a"), qa("qa-1", ["a"])];
    const beforeRef = before[0]!;
    const after = synthesizeQaReworkBackEdge(before, "qa-1");
    const producer = after.find((s) => s.id === "a")!;
    expect(producer.conditionalDependencies).toEqual([
      { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    // forward dependencies 불변
    expect(producer.dependencies).toEqual([]);
    // QA 자체는 변하지 않는다
    expect(after.find((s) => s.id === "qa-1")!.conditionalDependencies).toBeUndefined();
    // 배열 길이 불변
    expect(after).toHaveLength(2);
    // 불변: 원본 producer 객체와 다른 참조
    expect(after[0]).not.toBe(beforeRef);
    expect(beforeRef.conditionalDependencies).toBeUndefined(); // 원본 미변경
  });

  it("fan-in/synthesis: 의존성이 가장 많은 producer 를 고른다", () => {
    // a → b,c → syn 합성. qa 는 모두에 의존. producer 는 syn(의존성 2개로 최다).
    const steps = [
      action("a"),
      action("b", ["a"]),
      action("c", ["a"]),
      action("syn", ["b", "c"]),
      qa("qa-final", ["a", "b", "c", "syn"]),
    ];
    const after = synthesizeQaReworkBackEdge(steps, "qa-final");
    expect(after.find((s) => s.id === "syn")!.conditionalDependencies).toEqual([
      { stepId: "qa-final", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    // 다른 action 들은 back-edge 없음
    expect(after.find((s) => s.id === "b")!.conditionalDependencies).toBeUndefined();
  });

  it("maxIterations 기본값 = QA_REWORK_DEFAULT_MAX_ITERATIONS(2)", () => {
    expect(QA_REWORK_DEFAULT_MAX_ITERATIONS).toBe(2);
    const after = backEdge("a", "qa-1");
    expect(after[0]!.conditionalDependencies![0]!.maxIterations).toBe(2);
  });

  it("maxIterations < 1 입력 → 기본값으로 보정(무한 loop 방지 invariant)", () => {
    const after = backEdge("a", "qa-1", 0);
    expect(after[0]!.conditionalDependencies![0]!.maxIterations).toBe(2);
    const afterNeg = backEdge("a", "qa-1", -3);
    expect(afterNeg[0]!.conditionalDependencies![0]!.maxIterations).toBe(2);
  });

  it("사용자 지정 maxIterations(>=1) 는 그대로 반영", () => {
    const after = backEdge("a", "qa-1", 5);
    expect(after[0]!.conditionalDependencies![0]!.maxIterations).toBe(5);
  });
});

describe("synthesizeQaReworkBackEdge — skip/edge cases", () => {
  it("producer 후보가 없으면(모든 dep 가 QA) 입력 그대로 반환, 에러 없음", () => {
    const steps = [qa("qa-a", []), qa("qa-b", ["qa-a"])];
    const after = synthesizeQaReworkBackEdge(steps, "qa-b");
    expect(after).toBe(steps); // 동일 참조(변경 없음)
    expect(after.every((s) => s.conditionalDependencies === undefined)).toBe(true);
  });

  it("qaStepId 가 비어있거나 step 이 없으면 입력 그대로", () => {
    const steps = [action("a")];
    expect(synthesizeQaReworkBackEdge(steps, "")).toBe(steps);
    expect(synthesizeQaReworkBackEdge([], "qa-1")).toEqual([]);
  });

  it("qaStepId 가 steps 에 없으면 입력 그대로(resolveProducerStepIdFromDag null)", () => {
    const steps = [action("a"), qa("qa-1", ["a"])];
    expect(synthesizeQaReworkBackEdge(steps, "missing-qa")).toBe(steps);
  });
});

describe("synthesizeQaReworkBackEdge — dedup / 보존", () => {
  it("이미 동일 back-edge(같은 stepId/when/isBackEdge, 임의 maxIterations) 가 있으면 추가 안 함(저작자 보존)", () => {
    const existing = [{ stepId: "qa-1", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 7 }];
    const steps = [action("a", [], existing), qa("qa-1", ["a"])];
    const beforeRef = steps[0]!;
    const after = synthesizeQaReworkBackEdge(steps, "qa-1");
    // 동일 참조(변경 없음) — 저작자 maxIterations:7 보존, 덮어쓰지 않음
    expect(after[0]).toBe(beforeRef);
    expect(after[0]!.conditionalDependencies).toHaveLength(1);
    expect(after[0]!.conditionalDependencies![0]!.maxIterations).toBe(7);
  });

  it("producer 가 기존 conditionalDependencies(failure edge 등) 를 가지면 append(교체 ❌, 순서 보존)", () => {
    const existing = [{ stepId: "x", when: "failure" as const }];
    const steps = [action("a", [], existing), qa("qa-1", ["a"])];
    const after = synthesizeQaReworkBackEdge(steps, "qa-1");
    const producer = after.find((s) => s.id === "a")!;
    expect(producer.conditionalDependencies).toEqual([
      { stepId: "x", when: "failure" },
      { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    // 기존 edge 보존
    expect(producer.conditionalDependencies![0]).toEqual({ stepId: "x", when: "failure" });
  });
});

describe("synthesizeQaReworkBackEdge — round-trip / cycle 검증(무한 loop invariant)", () => {
  it("합성 back-edge 가 normalizeConditionalEdges 를 거쳐도 isBackEdge+maxIterations 보존(드롭 ❌)", () => {
    const after = backEdge("a", "qa-1");
    const normalized = normalizeConditionalEdges(after[0]!.conditionalDependencies);
    expect(normalized).toEqual([
      { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });

  it("합성 결과(producer→QA→producer cycle)를 cycle-validator 가 허용(hasDisallowedCycle=false)", () => {
    const after = backEdge("a", "qa-1");
    expect(hasDisallowedCycle(after)).toBe(false);
    // fan-in/synthesis 형태도
    const withRoot = synthesizeQaReworkBackEdge(
      [action("a"), action("b", ["a"]), action("syn", ["b"]), qa("qa-final", ["a", "b", "syn"])],
      "qa-final",
    );
    expect(hasDisallowedCycle(withRoot)).toBe(false);
  });

  it("불변: 변경되지 않은 step 들은 참조 보존, producer 만 새 객체", () => {
    const steps = [action("a"), action("b", ["a"]), qa("qa-1", ["a", "b"])];
    const originals = [...steps];
    const after = synthesizeQaReworkBackEdge(steps, "qa-1");
    // producer(b, 의존성 1로 a 의 0 보다 많음 → b 선택)는 새 객체
    const producerIdx = after.findIndex((s) => s.conditionalDependencies?.some((e) => e.stepId === "qa-1"));
    expect(producerIdx).toBeGreaterThanOrEqual(0);
    expect(after[producerIdx]).not.toBe(originals[producerIdx]);
    expect(after[producerIdx]?.id).toBe("b"); // 어떤 step 이 producer 인지 명시적으로 pin
    // 나머지는 동일 참조
    after.forEach((s, i) => {
      if (i !== producerIdx) expect(s).toBe(originals[i]);
    });
  });
});

describe("synthesizeQaReworkBackEdge — 선형 chain 동점 tie-break(문서화된 한계 pinning)", () => {
  // resolveProducerStepIdFromDag 가 의존성 수 DESC 정렬 후 producers[0] 를 고른다. 동점이면
  // 안정 정렬이 qa.dependencies 배열 순서를 보존 → 첫 non-QA 가 producer. PAQO 일반(fan-in/synthesis)에선
  // 정확히 synthesis 가 선택되지만, 순수 선형/병렬 동점에선 "첫 후보" 가 선택된다(문서화된 한계, 별도 follow-up).
  it("동점(모두 의존성 0)이면 qa.dependencies 의 첫 non-QA 가 producer", () => {
    const steps = [action("a"), action("b"), action("c"), qa("qa-1", ["a", "b", "c"])];
    const after = synthesizeQaReworkBackEdge(steps, "qa-1");
    expect(after.find((s) => s.id === "a")!.conditionalDependencies).toEqual([
      { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(after.find((s) => s.id === "b")!.conditionalDependencies).toBeUndefined();
    expect(after.find((s) => s.id === "c")!.conditionalDependencies).toBeUndefined();
  });

  it("reverse: qa.dependencies=[c,b,a] 면 c 가 producer(배열 순서 의존)", () => {
    const steps = [action("a"), action("b"), action("c"), qa("qa-1", ["c", "b", "a"])];
    const after = synthesizeQaReworkBackEdge(steps, "qa-1");
    expect(after.find((s) => s.id === "c")!.conditionalDependencies).toHaveLength(1);
    expect(after.find((s) => s.id === "a")!.conditionalDependencies).toBeUndefined();
    expect(after.find((s) => s.id === "b")!.conditionalDependencies).toBeUndefined();
  });
});
