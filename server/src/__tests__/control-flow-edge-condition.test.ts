import { describe, expect, it } from "vitest";
import type { ConditionalEdge } from "../services/workflow/control-flow/types.js";
import {
  classifyStepActivation,
  findSkippableSteps,
  resolveEdges,
  workflowHasConditionalEdges,
  type EdgeBearingStep,
  type PredFacts,
  type PredStatus,
} from "../services/workflow/control-flow/edge-condition.js";

/**
 * [목적] P2 IF(조건부 edge) 활성화 평가(edge-condition.ts)의 순수 유닛 테스트.
 *   DB/Date 없이 결정적(deterministic)으로 검증 — 가즈아 무한 loop 가드 회귀 탐지 포함.
 *   검증 범위:
 *     1) legacy dependencies[]-only step 은 기존 dependencies.every(completed) 와 byte-identical (회귀 금지).
 *     2) conditional edge(when: success/failure/always/qa_request_changes) 의 발화/대기/skip 판정.
 *     3) multi-edge hard-required 충돌(success 실패가 rescue failure edge 보다 우선).
 *     4) findSkippableSteps batch selector + 자격(eligible)/launchedStepIds 필터.
 */

function preds(
  input: Record<string, { status: PredStatus; isQaGate?: boolean; verdict?: "pass" | "request_changes" | null }>,
): Map<string, PredFacts> {
  const map = new Map<string, PredFacts>();
  for (const [id, value] of Object.entries(input)) {
    map.set(id, {
      status: value.status,
      isQaGate: value.isQaGate ?? false,
      verdict: value.verdict ?? null,
    });
  }
  return map;
}

function step(
  id: string,
  opts: { dependencies?: string[]; conditionalDependencies?: ConditionalEdge[] } = {},
): EdgeBearingStep {
  return { id, dependencies: opts.dependencies, conditionalDependencies: opts.conditionalDependencies };
}

describe("workflowHasConditionalEdges", () => {
  it("conditionalDependencies 를 가진 step 이 하나라도 있으면 true", () => {
    expect(workflowHasConditionalEdges([step("a"), step("b", { conditionalDependencies: [{ stepId: "a", when: "failure" }] })])).toBe(true);
  });
  it("legacy-only step 들이면 false", () => {
    expect(workflowHasConditionalEdges([step("a"), step("b", { dependencies: ["a"] })])).toBe(false);
    expect(workflowHasConditionalEdges([])).toBe(false);
  });
});

describe("resolveEdges", () => {
  it("legacy dependencies[] 는 when:success edge 로 환산되고 conditional 과 합쳐진다", () => {
    const edges = resolveEdges(step("c", {
      dependencies: ["a", "b"],
      conditionalDependencies: [{ stepId: "d", when: "failure" }],
    }));
    expect(edges).toEqual([
      { stepId: "a", when: "success" },
      { stepId: "b", when: "success" },
      { stepId: "d", when: "failure" },
    ]);
  });
});

describe("classifyStepActivation — legacy 호환성 (회귀 금지)", () => {
  it("모든 legacy dep completed → runnable (기존 dependencies.every(completed) 과 동일)", () => {
    const s = step("c", { dependencies: ["a", "b"] });
    expect(classifyStepActivation(s, preds({ a: { status: "completed" }, b: { status: "completed" } })).runnable).toBe(true);
  });
  it("legacy dep 하나라도 failed → runnable 아님. 도달 불가이므로 skippable=true (순수 함수 레벨). 단 dag-engine skip-pass 가 workflow-gate 아래서만 실행되므로 순수 legacy 워크플로에선 실제 skip 되지 않고 pending 대기=회복 가능하다.", () => {
    const s = step("c", { dependencies: ["a", "b"] });
    const act = classifyStepActivation(s, preds({ a: { status: "completed" }, b: { status: "failed" } }));
    expect(act.runnable).toBe(false);
    expect(act.waiting).toBe(false);
    expect(act.skippable).toBe(true); // pure: 도달 불가. workflow-gate(dag-engine)가 legacy 회복 보존을 담당.
  });
  it("legacy dep 가 아직 terminal 아님 → waiting", () => {
    const s = step("c", { dependencies: ["a"] });
    expect(classifyStepActivation(s, preds({ a: { status: "running" } }))).toMatchObject({ runnable: false, waiting: true });
  });
  it("entry step(dep 없음) → runnable 즉시 발화", () => {
    expect(classifyStepActivation(step("root"), preds({})).runnable).toBe(true);
  });
});

describe("classifyStepActivation — conditional edge (IF)", () => {
  it("when:failure — 선행 failed → runnable, 선행 completed → skippable, 선행 pending → waiting", () => {
    const s = step("c", { conditionalDependencies: [{ stepId: "a", when: "failure" }] });
    expect(classifyStepActivation(s, preds({ a: { status: "failed" } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ a: { status: "skipped" } })).runnable).toBe(true); // skipped 도 failure 에 흡수
    expect(classifyStepActivation(s, preds({ a: { status: "completed" } })).skippable).toBe(true); // false-branch → skip
    expect(classifyStepActivation(s, preds({ a: { status: "running" } })).waiting).toBe(true);
  });
  it("when:always — 선행이 terminal 이면 어떤 결과라도 runnable (joiner)", () => {
    const s = step("c", { conditionalDependencies: [{ stepId: "a", when: "always" }] });
    expect(classifyStepActivation(s, preds({ a: { status: "completed" } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ a: { status: "failed" } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ a: { status: "skipped" } })).runnable).toBe(true);
  });
  it("when:success(명시) — 선행 completed → runnable, failed → skippable", () => {
    const s = step("c", { conditionalDependencies: [{ stepId: "a", when: "success" }] });
    expect(classifyStepActivation(s, preds({ a: { status: "completed" } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ a: { status: "failed" } })).skippable).toBe(true);
  });
  it("when:qa_request_changes — P2 fallback: QA gate && failed → runnable; verdict 주어지면 verdict 기반", () => {
    const s = step("c", { conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] });
    expect(classifyStepActivation(s, preds({ qa: { status: "failed", isQaGate: true } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ qa: { status: "failed", isQaGate: false } })).skippable).toBe(true);
    // verdict 명시(P4 호환): request_changes 만 발화
    expect(classifyStepActivation(s, preds({ qa: { status: "failed", isQaGate: true, verdict: "request_changes" } })).runnable).toBe(true);
    expect(classifyStepActivation(s, preds({ qa: { status: "completed", isQaGate: true, verdict: "pass" } })).skippable).toBe(true);
  });
});

describe("classifyStepActivation — multi-edge hard-required 충돌", () => {
  // step X: legacy success[A] + conditional failure[B]. A 실패하면 rescue failure edge[B] 가 있어도 skip.
  const x = step("x", { dependencies: ["a"], conditionalDependencies: [{ stepId: "b", when: "failure" }] });
  it("A completed + B failed → runnable (둘 다 조건 만족)", () => {
    expect(classifyStepActivation(x, preds({ a: { status: "completed" }, b: { status: "failed" } })).runnable).toBe(true);
  });
  it("A failed + B failed → skippable (success hard-required 실패가 rescue 보다 우선 — 최소놀람)", () => {
    const act = classifyStepActivation(x, preds({ a: { status: "failed" }, b: { status: "failed" } }));
    expect(act.runnable).toBe(false);
    expect(act.skippable).toBe(true);
  });
  it("A pending → waiting (A 가 terminal 이어야 결정 가능)", () => {
    expect(classifyStepActivation(x, preds({ a: { status: "running" }, b: { status: "failed" } })).waiting).toBe(true);
  });
  // [always 우선순위] success[A] + always[C]: sibling success 실패가 always joiner 보다 우선(최소놀람).
  const y = step("y", { conditionalDependencies: [{ stepId: "a", when: "success" }, { stepId: "c", when: "always" }] });
  it("A failed + C completed → skippable (sibling success 실패가 always 보다 우선)", () => {
    const act = classifyStepActivation(y, preds({ a: { status: "failed" }, c: { status: "completed" } }));
    expect(act.runnable).toBe(false);
    expect(act.skippable).toBe(true);
  });
  it("A completed + C completed → runnable (둘 다 성립)", () => {
    expect(classifyStepActivation(y, preds({ a: { status: "completed" }, c: { status: "completed" } })).runnable).toBe(true);
  });
});

describe("findSkippableSteps", () => {
  const steps = [
    step("legacy-failed", { dependencies: ["a"] }), // a failed → 도달 불가 → skip 대상(legacy 도 포함)
    step("false-branch", { conditionalDependencies: [{ stepId: "a", when: "success" }] }), // a failed → skip
    step("will-run", { conditionalDependencies: [{ stepId: "a", when: "failure" }] }), // a failed → runnable, skip 아님
  ];
  const facts = preds({ a: { status: "failed" }, "legacy-failed": { status: "pending" }, "false-branch": { status: "pending" }, "will-run": { status: "pending" } });

  it("도달 불가 step(legacy + conditional 모두)을 반환하고 runnable 은 제외한다", () => {
    const out = findSkippableSteps(steps, facts, {});
    expect(out.map((s) => s.id).sort()).toEqual(["false-branch", "legacy-failed"]);
  });
  it("isStepEligible 로 pending 여부를 주입할 수 있다(예: 이미 issue 생성된 step 제외)", () => {
    // false-branch 를 제외하면 legacy-failed 만 남는다(broaden 후 legacy 도 skip 대상).
    const out = findSkippableSteps(steps, facts, {
      isStepEligible: (s) => s.id !== "false-branch",
    });
    expect(out.map((s) => s.id)).toEqual(["legacy-failed"]);
  });
  it("launchedStepIds 밖의 step 은 제외된다", () => {
    const out = findSkippableSteps(steps, facts, { launchedStepIds: new Set(["will-run"]) });
    expect(out).toEqual([]); // legacy-failed/false-branch 가 launchedStepIds 에 없으면 제외
  });
});
