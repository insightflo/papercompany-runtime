import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMissionIntent, intentSignalsByCategory } from "../services/missions/mission-intent.js";
import { buildClarificationRequest, extractUnitRoles, getMissionPlanQaCritiqueHook, reviewPlanAgainstIntent,
  setMissionPlanQaCritiqueHook, type PlanQaDiagnostic } from "../services/missions/mission-plan-qa.js";
import { buildCapabilityManifest, resolveSitePublishTarget } from "../services/missions/mission-owner-planning-context.js";
import { publicationTools, publicationUnits } from "./helpers/mission-publication-fixture.js";

const intent = extractMissionIntent({ selectedExecutionUnits: publicationUnits(), tools: publicationTools });
const review = (units: Record<string, unknown>[]) => reviewPlanAgainstIntent({ intent, selectedExecutionUnits: units, tools: publicationTools });
const producer = { id: "a", type: "action", graphWorkProductRequired: true };
const qa = { id: "q", type: "qa", dependsOn: ["a"] };
const publisher = { ...publicationUnits()[0], dependsOn: ["q"] };
const verifier = { ...publicationUnits()[1], toolArgs: { receiptInput: "{$steps.p.workProductPath}" } };

describe("structured mission intent", () => {
  it("records declared publication signals", () => {
    expect(intent.publish).toBe(true);
    expect(intentSignalsByCategory(intent, "publish")).toEqual(["publication"]);
  });
  it.each(["publish HTML", "AI and developers", "scenario cases", "게시 배포 상황별 초보자"])("does not parse %s", text => {
    expect(extractMissionIntent(text)).toMatchObject({ publish: false, audienceSplit: false, scenario: false });
  });
  it("accepts explicit audience and scenario arrays", () => {
    expect(extractMissionIntent({ audiences: ["reader", "operator"], scenarios: ["normal"] })).toMatchObject({ audienceSplit: true, scenario: true });
  });
});
describe("plan-time publication QA", () => {
  it("reports absent publication if caller requires it", () => {
    expect(review([producer, qa]).map(d => d.code)).toContain("missing_publish_unit");
  });
  it("accepts declared producer → QA → publication → bound verification", () => {
    expect(review([producer, qa, publisher, verifier])).toEqual([]);
  });
  it("rejects missing downstream readback", () => {
    expect(review([{ ...publisher, dependsOn: [] }]).map(d => d.code)).toContain("missing_publish_readback_qa");
  });
  it("requires artifact QA before publication for declared producers", () => {
    const codes = review([producer, { ...publisher, dependsOn: ["a"] }]).map(d => d.code);
    expect(codes).toContain("missing_artifact_qa_before_delivery");
  });
  it("rejects reversed artifact QA order", () => {
    expect(review([producer, { ...publisher, dependsOn: ["a"] }, { ...qa, dependsOn: ["p"] }]).map(d => d.code)).toContain("invalid_artifact_qa_delivery_order");
  });
  it("cannot satisfy topology with title or role alone", () => {
    expect(review([{ ...publisher, dependsOn: [] }, { id: "v", type: "qa", title: "readback verified", dependsOn: ["p"] }]).map(d => d.code)).toContain("missing_publication_verify_tool");
  });
  it("does not treat prose verification as an explicit role", () => {
    expect(extractUnitRoles({ title: "[QA] verify artifact" }).readbackQa).toBe(false);
    expect(extractUnitRoles({ type: "qa" }).readbackQa).toBe(true);
  });
});
describe("structured clarification", () => {
  const required = extractMissionIntent({ audiences: ["reader", "operator"], scenarios: ["normal"] });
  it("reports missing declared coverage", () => {
    expect(reviewPlanAgainstIntent({ intent: required, selectedExecutionUnits: [] }).map(d => d.code)).toEqual(["missing_audience_split", "missing_scenario_taxonomy"]);
  });
  it("prose success criteria cannot satisfy coverage", () => {
    expect(reviewPlanAgainstIntent({ intent: required, selectedExecutionUnits: [], successCriteria: ["audience cases"] })).toHaveLength(2);
  });
  it("explicit unit fields satisfy coverage", () => {
    expect(reviewPlanAgainstIntent({ intent: required, selectedExecutionUnits: [{ id: "unit", audiences: ["reader", "operator"], scenarios: ["normal"] }] })).toEqual([]);
  });
  it("only clarification diagnostics create questions", () => {
    const diagnostics: PlanQaDiagnostic[] = [
      { code: "missing_audience_split", severity: "needs_clarification", message: "gap" },
      { code: "missing_publish_unit", severity: "invalid", message: "gap" },
    ];
    expect(buildClarificationRequest({ diagnostics, intent: required })).toMatchObject([{ code: "missing_audience_split", intentContext: ["reader", "operator"] }]);
  });
  it("no clarification produces no question", () => {
    expect(buildClarificationRequest({ diagnostics: [], intent: required })).toEqual([]);
  });
});
describe("bounded capability discovery", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns empty capabilities without declarations", () => {
    expect(buildCapabilityManifest([]).publishCapabilities).toEqual([]);
  });
  it("gets publication capability from tools rather than skill names", () => {
    expect(buildCapabilityManifest([], { tools: publicationTools }).publishCapabilities.map(s => s.key)).toEqual(["alpha"]);
  });
  it("bounds skill purpose text", () => {
    const entry = buildCapabilityManifest([{ key: "s", slug: "s", name: "S", description: "x".repeat(500) }]).notableSkills[0]!;
    expect(entry.purpose.length).toBeLessThanOrEqual(160);
  });
  it("can scope discovery to explicit intent", () => {
    expect(buildCapabilityManifest([], { tools: publicationTools, intent: extractMissionIntent({}) }).publishCapabilities).toEqual([]);
  });
  it("reads configured staging directory only", async () => {
    vi.stubEnv("PAPERCOMPANY_PUBLICATION_SITE_ROOT", process.env.TMPDIR ?? "/tmp");
    expect(await resolveSitePublishTarget()).toMatchObject({ available: true, canStage: true });
  });
  it("reports missing configured directory", async () => {
    vi.stubEnv("PAPERCOMPANY_PUBLICATION_SITE_ROOT", "/definitely/missing/directory");
    expect(await resolveSitePublishTarget()).toMatchObject({ available: false, canStage: false });
  });
});
describe("critique hook", () => {
  afterEach(() => setMissionPlanQaCritiqueHook(null));
  it("registers and clears structured diagnostic hooks", () => {
    const hook = async (): Promise<PlanQaDiagnostic[]> => [];
    expect(getMissionPlanQaCritiqueHook()).toBeNull();
    setMissionPlanQaCritiqueHook(hook);
    expect(getMissionPlanQaCritiqueHook()).toBe(hook);
  });
});
