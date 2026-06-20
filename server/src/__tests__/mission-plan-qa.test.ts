import { describe, expect, it } from "vitest";
import { extractMissionIntent, intentSignalsByCategory } from "../services/missions/mission-intent.js";
import {
  extractUnitRoles,
  reviewPlanAgainstIntent,
  type PlanQaDiagnostic,
} from "../services/missions/mission-plan-qa.js";
import { buildCapabilityManifest } from "../services/missions/mission-owner-planning-context.js";

/**
 * [목적] plan-time QA MVP(mission-intent + mission-plan-qa) 의 순수 로직 검증.
 *   핵심 회귀: 실제 사용자 brief("...site에 올리도록") 에서 publish intent 가 잡히고,
 *   publish/readback unit 이 없는 plan 은 missing_publish_unit(invalid) 로 reject 되어야 한다.
 *   DB 없이 deterministic.
 */

const REAL_BRIEF_TITLE = "디자인 경험 없는 사람이 AI 또는 웹 디자이너에게 UI/UX/배치/색감/수정지시 전달법 리서치";
const REAL_BRIEF_DESC = "전달하는 법을 리서치하고 site에 올리도록";

function unit(over: Record<string, unknown>): Record<string, unknown> {
  return { kind: "mission_plan_unit", selectionState: "selected", ...over };
}

describe("extractMissionIntent — 실제 brief", () => {
  const intent = extractMissionIntent(REAL_BRIEF_TITLE, REAL_BRIEF_DESC);
  it("publish intent 감지(site에 올려)", () => {
    expect(intent.publish).toBe(true);
    expect(intentSignalsByCategory(intent, "publish")).toContain("site");
  });
  it("audience split 감지(AI + 웹 디자이너, 복수 대상)", () => {
    expect(intent.audienceSplit).toBe(true);
    expect(intent.audiences).toEqual(expect.arrayContaining(["AI", "웹 디자이너"]));
  });
});

describe("extractMissionIntent — legacy/순수 research", () => {
  it("게시/대상/시나리오 의도 없으면 모두 false(회귀 없이 pass 조건)", () => {
    const intent = extractMissionIntent("주간 기술 동향 리서치", "최근 AI 논문을 요약해 정리한다");
    expect(intent.publish).toBe(false);
    expect(intent.audienceSplit).toBe(false);
    expect(intent.scenario).toBe(false);
  });
  it("scenario 의도 감지(상황별/케이스별)", () => {
    const intent = extractMissionIntent("상황별 대응 가이드", "여러가지 상황에 대한 케이스별 매뉴얼 작성");
    expect(intent.scenario).toBe(true);
  });
});

describe("reviewPlanAgainstIntent — 핵심 회귀(reject 케이스)", () => {
  const intent = extractMissionIntent(REAL_BRIEF_TITLE, REAL_BRIEF_DESC);

  it("실제 brief: research→synthesis→QA 만 있고 publish/readback unit 이 없으면 missing_publish_unit(invalid) reject", () => {
    // 사용자가 보고한 버그 케이스: publish intent 인데 publish unit 이 빠진 plan.
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-research", title: "전달법 리서치", sourceRef: { type: "mission_plan_unit", id: "u-research" } }),
        unit({ id: "u-synth", title: "리서치 종합 보고서 작성", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
        unit({ id: "u-qa", title: "[QA] 보고서 검증", sourceRef: { type: "mission_plan_unit", id: "u-qa" } }),
      ],
    });
    const codes = diag.map((d) => d.code);
    expect(codes).toContain("missing_publish_unit");
    expect(diag.find((d) => d.code === "missing_publish_unit")?.severity).toBe("invalid");
  });

  it("publish unit + QA/readback unit 이 있으면 invalid 없이 통과(needs_clarification 만 허용)", () => {
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-research", title: "전달법 리서치", sourceRef: { type: "mission_plan_unit", id: "u-research" } }),
        unit({ id: "u-synth", title: "보고서 합성", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
        unit({ id: "u-publish", title: "site에 HTML 게시/배포", sourceRef: { type: "mission_plan_unit", id: "u-publish" } }),
        unit({ id: "u-qa", title: "[QA] 게시물 readback 검증", sourceRef: { type: "mission_plan_unit", id: "u-qa" } }),
      ],
    });
    const blocking = diag.filter((d) => d.severity === "invalid");
    expect(blocking).toEqual([]);
  });

  it("publish unit 은 있으나 QA/readback 검증 unit 이 없으면 missing_publish_readback_qa(invalid)", () => {
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-research", title: "리서치", sourceRef: { type: "mission_plan_unit", id: "u-research" } }),
        unit({ id: "u-publish", title: "사이트에 게시", sourceRef: { type: "mission_plan_unit", id: "u-publish" } }),
      ],
    });
    const codes = diag.map((d) => d.code);
    expect(codes).toContain("missing_publish_readback_qa");
    expect(diag.find((d) => d.code === "missing_publish_readback_qa")?.severity).toBe("invalid");
  });
});

describe("reviewPlanAgainstIntent — needs_clarification(audience/scenario)", () => {
  it("audience split 인데 대상 분기 근거가 없으면 missing_audience_split(needs_clarification, non-blocking)", () => {
    const intent = extractMissionIntent("AI 와 웹 디자이너를 위한 가이드", "각 대상에게 전달하는 법 정리");
    expect(intent.audienceSplit).toBe(true);
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-synth", title: "단일 통합 가이드 작성", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
      ],
    });
    const found = diag.find((d) => d.code === "missing_audience_split");
    expect(found).toBeTruthy();
    expect(found?.severity).toBe("needs_clarification");
  });

  it("scenario 인데 시나리오/상황별 unit 이나 successCriteria 가 없으면 missing_scenario_taxonomy(needs_clarification)", () => {
    const intent = extractMissionIntent("상황별 대응 매뉴얼", "여러가지 상황 케이스 정리");
    expect(intent.scenario).toBe(true);
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-synth", title: "일반 매뉴얼 작성", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
      ],
    });
    const found = diag.find((d) => d.code === "missing_scenario_taxonomy");
    expect(found).toBeTruthy();
    expect(found?.severity).toBe("needs_clarification");
  });

  it("scenario 인데 successCriteria 에 상황별 근거가 있으면 diagnostic 없음", () => {
    const intent = extractMissionIntent("상황별 대응 매뉴얼", "여러가지 상황 케이스 정리");
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-synth", title: "매뉴얼 작성", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
      ],
      successCriteria: ["각 상황별 케이스를 다루어야 한다"],
    });
    expect(diag.find((d) => d.code === "missing_scenario_taxonomy")).toBeFalsy();
  });
});

describe("reviewPlanAgainstIntent — legacy 보존", () => {
  it("intent 없는 research-only mission 은 diagnostic 없음(회귀 없음)", () => {
    const intent = extractMissionIntent("주간 기술 동향 리서치", "AI 논문 요약 정리");
    const diag = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [
        unit({ id: "u-research", title: "논문 리서치", sourceRef: { type: "mission_plan_unit", id: "u-research" } }),
        unit({ id: "u-synth", title: "요약 정리", sourceRef: { type: "mission_plan_unit", id: "u-synth" } }),
      ],
    });
    expect(diag).toEqual([] as PlanQaDiagnostic[]);
  });
});

describe("extractUnitRoles", () => {
  it("[QA] prefix / readback / publish 키워드를 역할로 잡는다", () => {
    expect(extractUnitRoles(unit({ title: "[QA] 게시물 검증" })).readbackQa).toBe(true);
    expect(extractUnitRoles(unit({ title: "게시물 readback 확인" })).readbackQa).toBe(true);
    expect(extractUnitRoles(unit({ title: "site에 HTML 게시" })).publish).toBe(true);
    expect(extractUnitRoles(unit({ title: "배포 파이프라인 실행" })).publish).toBe(true);
  });
});

describe("buildCapabilityManifest (capability discovery)", () => {
  it("빈 skills → 빈 manifest, sitePublishTarget.available=null(runtime 미구현 표식)", () => {
    const manifest = buildCapabilityManifest([]);
    expect(manifest.publishCapabilities).toEqual([]);
    expect(manifest.notableSkills).toEqual([]);
    expect(manifest.sitePublishTarget.available).toBe(null);
  });
  it("publisher 계열 skill(manual-onboarding-publisher)을 publishCapabilities 로 분리", () => {
    const manifest = buildCapabilityManifest([
      { key: "manual-onboarding-publisher", slug: "publisher", name: "Manual Onboarding Publisher", description: "site에 산출물을 게시/배포한다." },
      { key: "research-helper", slug: "research", name: "Research Helper", description: "리서치 보조." },
    ]);
    expect(manifest.publishCapabilities.map((s) => s.key)).toContain("manual-onboarding-publisher");
    expect(manifest.publishCapabilities.map((s) => s.key)).not.toContain("research-helper");
    expect(manifest.notableSkills.map((s) => s.key)).toEqual(expect.arrayContaining(["manual-onboarding-publisher", "research-helper"]));
  });
  it("description 이 길면 purpose 가 truncation 된다(raw SKILL.md 전문 미포함)", () => {
    const long = "x".repeat(500);
    const manifest = buildCapabilityManifest([{ key: "s", slug: "s", name: "S", description: long }]);
    expect(manifest.notableSkills[0]?.purpose.length).toBeLessThan(long.length);
    expect(manifest.notableSkills[0]?.purpose.endsWith("…")).toBe(true);
  });
});

