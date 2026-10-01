import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMissionIntent } from "../services/missions/mission-intent.js";
import { autofillPublicationResult as autofill } from "../services/missions/mission-plan-publish-result-autofill.js";
import { reviewPublicationVerificationTopology as review } from "../services/missions/mission-plan-publication-contract.js";
import { extractMissionQualityContract } from "../services/missions/mission-quality-contract.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";
import { buildCapabilityManifest, resolveSitePublishTarget } from "../services/missions/mission-owner-planning-context.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { isMissionPlanUnitMaterialized } from "../services/missions/mission-plan-dependency-graph.js";
import { validateDeclaredStructuralPlan } from "../services/missions/structural-plan-validation.js";
import { buildMissionPlanningDescription } from "../services/missions/mission-planning-description.js";
import { synthesizeQaReworkBackEdge } from "../services/missions/workflow-qa-rework.js";
import { publicationTools, publicationUnits } from "./helpers/mission-publication-fixture.js";

afterEach(() => vi.unstubAllEnvs());
describe("declarative mission planning", () => {
  it("does not infer mission authority from prose", () => {
    expect(extractMissionIntent("publish HTML for AI and developers", "scenarios beginner deep research")).toMatchObject({
      publish: false, audienceSplit: false, scenario: false,
    });
  });
  it("derives publication only from selected registered contracts", () => {
    expect(extractMissionIntent({ selectedExecutionUnits: publicationUnits(), tools: publicationTools }).publish).toBe(true);
    expect(extractMissionIntent({ selectedExecutionUnits: publicationUnits(), tools: [] }).publish).toBe(false);
  });
  it("requires a downstream consumer with the declared receipt binding", () => {
    expect(review(publicationUnits(), publicationTools)).toHaveLength(1);
    const result = autofill(publicationUnits(), publicationTools);
    expect(result.applied?.field).toBe("receiptInput");
    expect(result.units[1]?.toolArgs).toEqual({ receiptInput: "{$steps.p.workProductPath}" });
    expect(review(result.units, publicationTools)).toEqual([]);
  });
  it("does not repair explicit conflicts or ambiguous publishers", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: "wrong" };
    expect(autofill(units, publicationTools).applied).toBeNull();
    expect(review(units, publicationTools)).toHaveLength(1);
    expect(autofill([...publicationUnits(), { ...units[0]!, id: "p2" }], publicationTools).applied).toBeNull();
  });
  it("tool names and prose alone do not enable topology or preflight gates", () => {
    const units = [{ id: "x", title: "write report and preflight workflow tools", graphWorkProductRequired: false,
      toolNames: ["publish-special"], description: "QA scenario audience" }];
    expect(reviewPlanAgainstIntent({ intent: extractMissionIntent("publish"), selectedExecutionUnits: units })).toEqual([]);
  });
  it("does not derive quality hard stops from prose", () => {
    expect(extractMissionQualityContract({ missionGoal: "beginner deep research publish HTML" }).hardStopRules).toEqual([]);
  });
  it("does not infer publication capabilities from skill names", () => {
    expect(buildCapabilityManifest([{ key: "publisher", slug: "publish", name: "Publisher", description: "" }]).publishCapabilities).toEqual([]);
  });
  it("publication site discovery is off without generic explicit configuration", async () => {
    vi.stubEnv("PAPERCOMPANY_PUBLICATION_SITE_ROOT", "");
    vi.stubEnv("MANUAL_ONBOARDING_SITE_ROOT", "/tmp");
    expect(await resolveSitePublishTarget()).toMatchObject({ available: false, canStage: false });
  });
  it("materializes explicit ACTION/QA/OVERSIGHT and does not grant a tool from research prose", () => {
    const units = [
      { id: "a", type: "action", title: "[QA] research sources", dependsOn: [] },
      { id: "q", type: "qa", title: "review", dependsOn: ["a"] },
      { id: "o", type: "oversight", title: "watch", dependsOn: ["q"] },
    ];
    const steps = buildPaqoWorkflowSteps({ missionGoal: "publish HTML", refs: { selectedExecutionUnits: units }, steps: [], successCriteria: [] } as never,
      { id: "mission", ownerAgentId: "owner", title: "publish" } as never, { researchWorkbenchAvailable: true });
    expect(steps.map(s => s.type)).toEqual(["action", "qa", "oversight", "qa"]);
    expect(steps[0]?.toolNames).toBeUndefined();
    expect(steps.at(-1)?.description).not.toContain("Delivery Verification:");
  });
  it("does not drop executable units because their title says oversight", () => {
    expect(isMissionPlanUnitMaterialized({ id: "a", type: "action", title: "[OVERSIGHT] inspect" })).toBe(true);
    expect(isMissionPlanUnitMaterialized({ id: "metadata", kind: "oversight" })).toBe(false);
  });
  it("validates semantic QA structural dependencies from type, not title", () => {
    const units = [
      { id: "a", type: "action" },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["validator"], dependsOn: ["a"] },
      { id: "review", type: "qa", title: "review", dependsOn: ["a"] },
    ];
    expect(validateDeclaredStructuralPlan(units).join(" ")).toContain("does not depend on structural");
    expect(validateDeclaredStructuralPlan([...units.slice(0, 2), { ...units[2], type: "action", title: "[QA]" }])).toEqual([]);
  });
  it("tells planners to submit explicit role fields", () => {
    const description = buildMissionPlanningDescription({ missionId: "mission", title: "plan", description: null, runnableRosterLines: [] });
    expect(description).toMatch(/"type":\s*"action"/);
    expect(description).toMatch(/"type":\s*"qa"/);
  });
  it("replays declared publication chains regardless of tool names", () => {
    const steps = [
      { id: "a", type: "action", dependencies: [] },
      { id: "p", type: "action", toolNames: ["alpha"], dependencies: ["a"] },
      { id: "v", type: "qa", toolNames: ["beta"], toolArgs: { receiptInput: "{$steps.p.workProductPath}" }, dependencies: ["p"] },
      { id: "q", type: "qa", dependencies: ["v"] },
    ];
    const result = synthesizeQaReworkBackEdge(steps, "q", 2, { tools: publicationTools });
    expect(result.filter(s => s.conditionalDependencies?.length).map(s => s.id)).toEqual(["p", "v"]);
  });
});
