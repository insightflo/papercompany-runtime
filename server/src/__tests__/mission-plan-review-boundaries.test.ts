import { describe, expect, it } from "vitest";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { normalizeMissionPlanDependencyGraph } from "../services/missions/mission-plan-dependency-graph.js";
import { buildMissionPlanningDescription } from "../services/missions/mission-planning-description.js";

const mission = { id: "mission", ownerAgentId: "owner", title: "Delivery" } as never;
function materialize(units: Record<string, unknown>[], steps: Record<string, unknown>[] = []) {
  return buildPaqoWorkflowSteps({ missionGoal: "Delivery", refs: { selectedExecutionUnits: units },
    steps, successCriteria: [] } as never, mission);
}

describe("agent plan policy boundary", () => {
  it.each([
    ["deliveryVerification", "required"], ["deliveryVerification", "off"],
    ["capAcceptance", "work_product"], ["capAcceptance", "off"],
    ["deliveryVerification", null], ["capAcceptance", {}],
  ])("rejects explicit %s=%j rather than silently dropping it", (field, value) => {
    const units = [{ id: "work", type: "action", [field]: value }];
    expect(normalizeMissionPlanDependencyGraph(units)).toMatchObject({ ok: false,
      diagnostics: [expect.objectContaining({ code: "board_only_plan_policy", message: expect.stringContaining(field) })] });
    expect(() => materialize(units)).toThrow(/board.*workflow API/i);
  });
  it("rejects policies on draft steps and filtered metadata too", () => {
    expect(() => materialize([{ id: "work", type: "action" }],
      [{ unitId: "work", deliveryVerification: "required" }])).toThrow(/deliveryVerification/);
    expect(() => materialize([{ id: "watch", kind: "oversight", capAcceptance: "off" }])).toThrow(/capAcceptance/);
  });
  it("keeps policy-free plans executable", () => {
    expect(materialize([{ id: "work", type: "action" }]).map(step => step.type)).toEqual(["action", "qa"]);
  });
});

describe("escalation oversight metadata", () => {
  it("materializes the actual general template without dispatching or waiting for escalation oversight", () => {
    const prompt = buildMissionPlanningDescription({ missionId: "mission", title: "Plan", description: null, runnableRosterLines: [] });
    const units = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
      .filter(unit => typeof unit.id === "string" && String(unit.id).startsWith("unit-"));
    expect(units.map(unit => unit.type)).toEqual(["action", "qa", "oversight"]);
    const graph = normalizeMissionPlanDependencyGraph(units);
    expect(graph.ok).toBe(true);
    if (!graph.ok) throw new Error("template should validate");
    expect(graph.graph.units[2]).toMatchObject({ type: "oversight", triggerOn: "escalation" });
    expect(graph.graph.materializedUnits.map(unit => unit.id)).toEqual(["unit-action-1", "unit-qa-1"]);
    const steps = materialize(units);
    expect(steps.map(step => step.type)).toEqual(["action", "qa", "qa"]);
    expect(steps.at(-1)!.dependencies).toEqual(steps.slice(0, 2).map(step => step.id));
    expect(steps.some(step => step.agentId === "<mission-owner-agent-id>")).toBe(false);
  });
  it("rejects normal work depending on escalation-only metadata instead of silently removing its prerequisite", () => {
    expect(normalizeMissionPlanDependencyGraph([
      { id: "watch", type: "oversight", triggerOn: "escalation" },
      { id: "work", type: "action", dependsOn: ["watch"] },
    ])).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "materialized_dependency_on_filtered_unit" })] });
  });
  it("still executes explicit ordinary oversight and ignores prose escalation keywords", () => {
    expect(materialize([{ id: "watch", type: "oversight", title: "escalation" }]).map(step => step.type))
      .toEqual(["oversight", "qa"]);
  });
});
