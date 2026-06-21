import { describe, expect, it } from "vitest";
import {
  normalizeConditionalEdges,
  type ConditionalEdge,
} from "../services/workflow/control-flow/types.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";

/**
 * [목적] P1 skeleton: control-flow edge/loop 데이터 모델(normalizeConditionalEdges)과
 *   WorkflowStep normalize round-trip 이 유효 edge 만 통과시키는지 검증. 동작(활성화/loop)은 P2+.
 */

describe("normalizeConditionalEdges", () => {
  it("유효한 success/failure/always edge 를 그대로 통과시킨다", () => {
    const out = normalizeConditionalEdges([
      { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
      { stepId: "action-1", when: "failure" },
      { stepId: "action-2" }, // when 생략 → success (명시하지 않음)
    ]);
    expect(out).toHaveLength(3);
    expect(out![0]).toMatchObject({ stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 });
    expect(out![1]).toMatchObject({ stepId: "action-1", when: "failure" });
    expect(out![2]?.when).toBeUndefined(); // success 는 명시하지 않아 default 로 평가되게 둔다
  });

  it("back-edge 는 maxIterations 동반 필수 — 없으면 drop(무한 loop 방지)", () => {
    const out = normalizeConditionalEdges([
      { stepId: "qa-1", isBackEdge: true }, // maxIterations 없 → drop
      { stepId: "qa-2", isBackEdge: true, maxIterations: 0 }, // 0 → 무효 → drop
      { stepId: "qa-3", isBackEdge: true, maxIterations: 3 }, // OK
    ]);
    expect(out).toEqual([{ stepId: "qa-3", isBackEdge: true, maxIterations: 3 }]);
  });

  it("잘못된 when 값은 무시(명시 생략→success 평가), stepId 없는 edge 는 drop", () => {
    const out = normalizeConditionalEdges([
      { stepId: "a", when: "bogus" },
      { stepId: "  ", when: "failure" },
      { when: "failure" },
      42 as unknown,
    ] as unknown[]);
    expect(out).toEqual([{ stepId: "a" }]); // when 무효→생략, 나머지 drop
  });

  it("빈 입력은 undefined(필드 생략)", () => {
    expect(normalizeConditionalEdges([])).toBeUndefined();
    expect(normalizeConditionalEdges(null)).toBeUndefined();
    expect(normalizeConditionalEdges(undefined)).toBeUndefined();
  });
});

describe("normalizeWorkflowStepsForExecution round-trip (conditionalDependencies)", () => {
  it("WorkflowStep normalize 가 conditionalDependencies 를 살려 반환한다", () => {
    const steps = normalizeWorkflowStepsForExecution([
      {
        id: "qa-1",
        name: "[QA] Verify",
        agentId: "agent-a",
        dependencies: ["action-1"],
        conditionalDependencies: [
          { stepId: "action-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
        ],
      },
    ]);
    expect(steps[0]?.conditionalDependencies).toEqual([
      { stepId: "action-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ] satisfies ConditionalEdge[]);
  });

  it("back-edge 에 maxIterations 없으면 normalize 가 drop 한다(round-trip 안전)", () => {
    const steps = normalizeWorkflowStepsForExecution([
      {
        id: "qa-1",
        name: "[QA] Verify",
        agentId: "agent-a",
        dependencies: ["action-1"],
        conditionalDependencies: [{ stepId: "action-1", isBackEdge: true }], // maxIterations 누락
      },
    ]);
    expect(steps[0]?.conditionalDependencies).toBeUndefined();
  });

  it("conditionalDependencies 없는 일반 step 는 그대로(legacy 동작 불변)", () => {
    const steps = normalizeWorkflowStepsForExecution([
      { id: "action-1", name: "Scout", agentId: "a", dependencies: [] },
    ]);
    expect(steps[0]?.conditionalDependencies).toBeUndefined();
    expect(steps[0]?.dependencies).toEqual([]);
  });
});
