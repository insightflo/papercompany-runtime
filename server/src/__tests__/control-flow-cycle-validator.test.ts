import { describe, expect, it } from "vitest";
import { hasDisallowedCycle } from "../services/workflow/control-flow/cycle-validator.js";
import type { ConditionalEdge } from "../services/workflow/control-flow/types.js";
import type { EdgeBearingStep } from "../services/workflow/control-flow/edge-condition.js";

/**
 * [목적] P3 cycle-validator 단위 테스트(순수, DB 없음).
 *   annotated back-edge(isBackEdge+maxIterations≥1) 로 닫히는 cycle(bounded loop)은 허용,
 *   그 외 cycle(우연/잘못된)은 거부. forward 방향 DFS 검증.
 */

function step(
  id: string,
  opts: { dependencies?: string[]; conditionalDependencies?: ConditionalEdge[] } = {},
): EdgeBearingStep {
  return { id, dependencies: opts.dependencies, conditionalDependencies: opts.conditionalDependencies };
}

describe("hasDisallowedCycle — 허용(비-cycle)", () => {
  it("cycle 없는 DAG → false", () => {
    const steps = [
      step("a"),
      step("b", { dependencies: ["a"] }),
      step("c", { dependencies: ["b"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(false);
  });
  it("빈/단일 step → false", () => {
    expect(hasDisallowedCycle([])).toBe(false);
    expect(hasDisallowedCycle([step("solo")])).toBe(false);
  });
});

describe("hasDisallowedCycle — annotated back-edge(bounded loop) 허용", () => {
  it("producer↔qa loop: producer 가 qa 로 back-edge(maxIterations≥1) → 허용(false)", () => {
    // producer(root) → qa(forward, qa depends on producer). producer 가 qa 로 back-edge(QA 반려 시 rework).
    const steps = [
      step("producer", { conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] }),
      step("qa", { dependencies: ["producer"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(false);
  });
  it("3-노드 loop(A→B→C→A)에서 C→A 가 back-edge 면 허용", () => {
    const steps = [
      step("a", { conditionalDependencies: [{ stepId: "c", isBackEdge: true, maxIterations: 3 }] }),
      step("b", { dependencies: ["a"] }),
      step("c", { dependencies: ["b"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(false);
  });
});

describe("hasDisallowedCycle — 우연/잘못된 cycle 거부", () => {
  it("legacy 양방향 의존(A↔B) → 거부(true)", () => {
    const steps = [
      step("a", { dependencies: ["b"] }),
      step("b", { dependencies: ["a"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(true);
  });
  it("3-노드 accidental cycle(A→B→C→A, back-edge 없음) → 거부", () => {
    const steps = [
      step("a", { dependencies: ["c"] }),
      step("b", { dependencies: ["a"] }),
      step("c", { dependencies: ["b"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(true);
  });
  it("back-edge 인데 maxIterations 누락 → 거부(무한 loop 방어)", () => {
    const steps = [
      step("producer", { conditionalDependencies: [{ stepId: "qa", isBackEdge: true }] as ConditionalEdge[] }),
      step("qa", { dependencies: ["producer"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(true);
  });
  it("back-edge 인데 maxIterations=0 → 거부", () => {
    const steps = [
      step("producer", { conditionalDependencies: [{ stepId: "qa", isBackEdge: true, maxIterations: 0 }] }),
      step("qa", { dependencies: ["producer"] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(true);
  });
});

describe("hasDisallowedCycle — orphan/혼합", () => {
  it("back-edge 가 unknown step 를 가리키면 orphan 은 무시(cycle 아님 처리)", () => {
    // from 이 steps 에 없으면 forward edge 생성 skip → cycle 없음. orphan 은 validateDag 가 담당.
    const steps = [
      step("a", { conditionalDependencies: [{ stepId: "ghost", isBackEdge: true, maxIterations: 1 }] }),
    ];
    expect(hasDisallowedCycle(steps)).toBe(false);
  });
});
