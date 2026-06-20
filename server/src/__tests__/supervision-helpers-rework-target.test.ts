import { describe, expect, it } from "vitest";
import {
  isQaLikeStep,
  parseReworkTargetRefFromNextAction,
  resolveProducerStepIdFromDag,
  type DagStepLike,
} from "../services/missions/supervision-helpers.js";

/**
 * [목적] QA-gate 회복의 rework 타겟 해석 helper(B: 사장 지목 / A: DAG 역참조) 검증.
 *   QA 반려 시 수정 대상은 산출물 생산자(synthesis)이지 QA 본인이 아니다.
 */

// 이 미션의 실제 PAQO WBS DAG. qa-6(최종검수)가 action-4(synthesis) 산출물을 반렸다.
const PAQO_STEPS: DagStepLike[] = [
  { id: "action-1-f39c231860", name: "Scout", dependencies: [] },
  { id: "action-2-fed63a3217", name: "Technology Research", dependencies: ["action-1-f39c231860"] },
  { id: "action-3-c01a38e727", name: "Economics Research", dependencies: ["action-1-f39c231860"] },
  { id: "action-4-dcbc31ebc7", name: "Synthesis", dependencies: ["action-2-fed63a3217", "action-3-c01a38e727"] },
  { id: "qa-5-109cd4a030", name: "Validate", dependencies: ["action-4-dcbc31ebc7"] },
  { id: "qa-6200a35259", name: "Verify mission result", dependencies: ["action-1-f39c231860", "action-2-fed63a3217", "action-3-c01a38e727", "action-4-dcbc31ebc7", "qa-5-109cd4a030"] },
];

describe("resolveProducerStepIdFromDag (A: DAG 역참조 → 생산자)", () => {
  it("QA step의 non-QA dependency 중 위상 마지막 생산자(synthesis)를 반환한다", () => {
    expect(resolveProducerStepIdFromDag("qa-6200a35259", PAQO_STEPS)).toBe("action-4-dcbc31ebc7");
  });

  it("QA를 다시 가리키지 않는다(qa-5는 제외)", () => {
    const producer = resolveProducerStepIdFromDag("qa-6200a35259", PAQO_STEPS);
    expect(producer).not.toMatch(/^qa-/);
  });

  it("qa-5(1차 검수)의 생산자도 synthesis(action-4)다", () => {
    expect(resolveProducerStepIdFromDag("qa-5-109cd4a030", PAQO_STEPS)).toBe("action-4-dcbc31ebc7");
  });

  it("QA step이 없거나 생산자 후보가 없으면 null", () => {
    expect(resolveProducerStepIdFromDag(null, PAQO_STEPS)).toBeNull();
    expect(resolveProducerStepIdFromDag("missing-step", PAQO_STEPS)).toBeNull();
    // 모든 dependency가 QA인 step
    const onlyQaDeps: DagStepLike[] = [
      { id: "qa-a", dependencies: [] },
      { id: "qa-b", name: "Validate", dependencies: ["qa-a"] },
    ];
    expect(resolveProducerStepIdFromDag("qa-b", onlyQaDeps)).toBeNull();
  });
});

describe("isQaLikeStep", () => {
  it("qa-/validate-/verify- 접두 또는 QA 계열 이름을 QA로 본다", () => {
    expect(isQaLikeStep({ id: "qa-6200a35259" })).toBe(true);
    expect(isQaLikeStep({ id: "qa-5-109cd4a030" })).toBe(true);
    expect(isQaLikeStep({ id: "step-1", name: "Verify report" })).toBe(true);
    expect(isQaLikeStep({ id: "step-2", title: "QA validation" })).toBe(true);
  });

  it("ACTION/연구 step은 QA가 아니다", () => {
    expect(isQaLikeStep({ id: "action-4-dcbc31ebc7", name: "Synthesis" })).toBe(false);
    expect(isQaLikeStep({ id: "action-2-fed63a3217", name: "Technology Research" })).toBe(false);
  });
});

describe("parseReworkTargetRefFromNextAction (B: 사장 지목 보조)", () => {
  it("owner 가 적은 'revise RES-XXXX' 에서 생산자 identifier를 추출한다", () => {
    expect(parseReworkTargetRefFromNextAction("revise RES-1329 to complete tooling coverage and citation hygiene, then rerun RES-1332")).toBe("RES-1329");
    expect(parseReworkTargetRefFromNextAction("redo CMPA-5371 with the fix")).toBe("CMPA-5371");
    expect(parseReworkTargetRefFromNextAction("rework the RES-100 report")).toBe("RES-100");
  });

  it("rework 동사가 없거나 identifier가 없으면 null", () => {
    expect(parseReworkTargetRefFromNextAction("rerun RES-1332 after the producer finishes")).toBeNull();
    expect(parseReworkTargetRefFromNextAction(undefined)).toBeNull();
    expect(parseReworkTargetRefFromNextAction("just wait")).toBeNull();
  });
});
