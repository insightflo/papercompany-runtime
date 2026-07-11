// @vitest-environment node
// [Mission Quality Contract] helper 가 goal 에서 품질 신호를 역추적해 contract 를
// 도출하는지 + 모호 goal 은 과차단 없이 clarify 만 내는지 검증.

import { describe, expect, it } from "vitest";
import {
  buildVerificationBeforeCompletionCriteria,
  extractMissionQualityContract,
  renderAdaptiveQualityProfileLines,
  renderEvidenceExplanationQaLines,
  renderEvidenceExplanationWritingLines,
  renderMissionQualityContractSection,
} from "../services/missions/mission-quality-contract.js";

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
    expect(contract.mustDeliver.some((m) => /intended audience/iu.test(m))).toBe(true);
    expect(contract.mustDeliver.some((m) => /source breadth|depth/iu.test(m))).toBe(true);
    expect(contract.failureCriteria.some((f) => /non-expert still cannot/iu.test(f))).toBe(true);

    expect(contract.hardStopRules.some((h) => /audience-appropriate/iu.test(h))).toBe(true);
    expect(contract.hardStopRules.join("\n")).not.toMatch(/what\s*\/\s*why\s*\/\s*how/iu);
    expect(contract.hardStopRules.some((h) => /source-breadth/iu.test(h))).toBe(true);
  });

  it("does NOT add aggressive hard-stop rules for a vague goal (no over-blocking)", () => {
    const contract = extractMissionQualityContract({ missionGoal: "write a brief summary" });
    expect(contract.underspecified).toBe(true);
    expect(contract.hardStopRules).toEqual([]);
    expect(contract.clarifyNote).not.toBeNull();
    expect(contract.clarifyNote).toMatch(/underspecified|clarify/iu);
  });

  it("uses outcome-oriented axes for every mission", () => {
    const contract = extractMissionQualityContract({ missionGoal: "do something" });
    expect(contract.evaluationAxes).toEqual([
      "intentFidelity",
      "outcomeUsefulness",
      "executionFeasibility",
      "verificationStrength",
      "integrationCompleteness",
    ]);
  });

  it("renders a Mission quality contract section with outcome-oriented axes", () => {
    const contract = extractMissionQualityContract({
      missionGoal: "초보자용 심층 가이드 작성",
    });
    const lines = renderMissionQualityContractSection(contract);
    expect(lines.join("\n")).toContain("## Mission quality contract");
    expect(lines.join("\n")).toContain("intentFidelity");
  });

  it("renders adaptive profiles as selectable guidance rather than a universal checklist", () => {
    const lines = renderAdaptiveQualityProfileLines().join("\n");
    expect(lines).toContain("Infer the mission's work type");
    expect(lines).toContain("Research / opportunity discovery");
    expect(lines).toContain("Software delivery");
    expect(lines).toContain("Manual / beginner-facing guidance");
    expect(lines).toContain("Do not apply a profile merely because its terms appear in this guidance");
  });

  it("renders producer writing guidance for explaining evidence instead of pointing at source containers", () => {
    const lines = renderEvidenceExplanationWritingLines().join("\n");
    expect(lines).toContain("Evidence explanation quality");
    expect(lines).toContain("Write evidence chains");
    expect(lines).toContain("source content -> observation -> interpretation -> conclusion");
    expect(lines).toContain("Source content is");
    expect(lines).toContain("source content, observation, interpretation, conclusion");
    expect(lines).toContain("metric/event/text excerpt");
    expect(lines).toContain("source_name");
    expect(lines).toContain("path_or_url");
    expect(lines).toContain("private traceability");
    expect(lines).not.toContain("Those names may appear in source lists only after");
  });

  it("renders QA rejection criteria for source-pointer prose", () => {
    const lines = renderEvidenceExplanationQaLines().join("\n");
    expect(lines).toContain("Evidence explanation quality");
    expect(lines).toContain("Verify evidence chains before PASS");
    expect(lines).toContain("REQUEST_CHANGES");
    expect(lines).toContain("source content -> observation -> interpretation -> conclusion");
    expect(lines).toContain("PASS when public prose");
    expect(lines).toContain("source containers");
    expect(lines).toContain("observation, interpretation, and conclusion");
  });

  it("renders verification-before-completion criteria as a claim/evidence gate", () => {
    const criteria = buildVerificationBeforeCompletionCriteria();
    expect(criteria).toContain("Verification Before Completion");
    expect(criteria).toContain("fresh evidence");
    expect(criteria).toContain("Identify every completion claim");
    expect(criteria).toContain("Do not infer a provider");
    expect(criteria).toContain("notVerified");
    expect(criteria).toContain("finalVerdict");
    expect(criteria).toContain("Evidence explanation quality");
  });
});
