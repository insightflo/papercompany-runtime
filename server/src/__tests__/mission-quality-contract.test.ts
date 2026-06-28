// @vitest-environment node
// [Mission Quality Contract] helper 가 goal 에서 품질 신호를 역추적해 contract 를
// 도출하는지 + 모호 goal 은 과차단 없이 clarify 만 내는지 검증.

import { describe, expect, it } from "vitest";
import { extractMissionQualityContract, renderMissionQualityContractSection } from "../services/missions/mission-quality-contract.js";

describe("mission-quality-contract", () => {
  it("extracts beginner / deep-research / actionable signals from a Feynman-style brief", () => {
    const contract = extractMissionQualityContract({
      missionGoal:
        "storm-research skill 로 심층 상세 분석. 대충 조사 하지 말고 충분히 많은 자료 조사. report-for-beginners skill 로 html 작성. 초보자가 판단 가능 해야 한다.",
    });
    expect(contract.signals.beginnerFacing).toBe(true);
    expect(contract.signals.deepResearch).toBe(true);
    expect(contract.signals.actionableReport).toBe(true);
    expect(contract.underspecified).toBe(false);

    // mustDeliver / failureCriteria 에 beginner comprehension + source depth 반영
    expect(contract.mustDeliver.some((m) => /non-expert/iu.test(m))).toBe(true);
    expect(contract.mustDeliver.some((m) => /source breadth|depth/iu.test(m))).toBe(true);
    expect(contract.failureCriteria.some((f) => /non-expert still cannot/iu.test(f))).toBe(true);

    // clear beginner 신호 → hard-stop rule 포함
    expect(contract.hardStopRules.some((h) => /beginner-comprehension/iu.test(h))).toBe(true);
    expect(contract.hardStopRules.some((h) => /source-breadth/iu.test(h))).toBe(true);
  });

  it("does NOT add aggressive hard-stop rules for a vague goal (no over-blocking)", () => {
    const contract = extractMissionQualityContract({ missionGoal: "write a brief summary" });
    expect(contract.underspecified).toBe(true);
    expect(contract.hardStopRules).toEqual([]);
    expect(contract.clarifyNote).not.toBeNull();
    expect(contract.clarifyNote).toMatch(/underspecified|clarify/iu);
  });

  it("evaluation axes always include the 5 purpose-fitness axes", () => {
    const contract = extractMissionQualityContract({ missionGoal: "do something" });
    expect(contract.evaluationAxes).toEqual([
      "purposeFitness",
      "userProblemSolving",
      "contextFit",
      "executability",
      "formatProcessQuality",
    ]);
  });

  it("renders a Mission quality contract section with the 5 purpose-fitness axes", () => {
    const contract = extractMissionQualityContract({
      missionGoal: "초보자용 심층 가이드 작성",
    });
    const lines = renderMissionQualityContractSection(contract);
    expect(lines.join("\n")).toContain("## Mission quality contract");
    expect(lines.join("\n")).toContain("purposeFitness");
  });
});
