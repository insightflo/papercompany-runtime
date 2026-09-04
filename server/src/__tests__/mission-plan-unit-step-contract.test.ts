import { describe, expect, it } from "vitest";
import { buildMissionPlanUnitStepContract } from "../services/missions/mission-plan-unit-contract.js";

describe("buildMissionPlanUnitStepContract", () => {
  it("passes through explicit preconditions and postconditions given as trimmed strings", () => {
    const contract = buildMissionPlanUnitStepContract({
      preconditions: "  source data fetched  ",
      postconditions: "evening report file exists",
      undefinedBehaviors: "source api unreachable",
    });
    expect(contract).toEqual({
      preconditions: ["source data fetched"],
      postconditions: ["evening report file exists"],
      undefinedBehaviors: ["source api unreachable"],
    });
  });

  it("flattens explicit sections given as arrays and drops empty entries", () => {
    const contract = buildMissionPlanUnitStepContract({
      preconditions: ["a", "  b  ", ""],
      postconditions: ["c"],
      undefinedBehaviors: ["", "   "],
    });
    expect(contract).toEqual({
      preconditions: ["a", "b"],
      postconditions: ["c"],
    });
  });

  it("derives postconditions from plan fields when explicit postconditions are absent", () => {
    const contract = buildMissionPlanUnitStepContract({
      expectedOutput: "HTML report",
      acceptanceCriteria: "contains summary table",
      evidenceRequired: ["screenshot", "published url"],
    });
    expect(contract).toEqual({
      postconditions: [
        "Expected output: HTML report",
        "Acceptance criteria: contains summary table",
        "Evidence required: screenshot; published url",
      ],
    });
  });

  it("derives a single postcondition line from acceptanceCriteria", () => {
    const contract = buildMissionPlanUnitStepContract({
      acceptanceCriteria: "board shows company card",
    });
    expect(contract?.postconditions).toContain("Acceptance criteria: board shows company card");
  });

  it("keeps explicit postconditions and ignores plan fields when both are present", () => {
    const contract = buildMissionPlanUnitStepContract({
      postconditions: "explicit contract wins",
      expectedOutput: "derived line must not appear",
    });
    expect(contract).toEqual({ postconditions: ["explicit contract wins"] });
  });

  it("returns null when the unit has no contract data", () => {
    expect(buildMissionPlanUnitStepContract({ title: "unit", kind: "action" })).toBeNull();
    expect(buildMissionPlanUnitStepContract({})).toBeNull();
  });

  it("returns null when sections are empty strings, whitespace, or unsupported shapes", () => {
    expect(buildMissionPlanUnitStepContract({ preconditions: "   " })).toBeNull();
    expect(buildMissionPlanUnitStepContract({ postconditions: ["", "   "] })).toBeNull();
    expect(buildMissionPlanUnitStepContract({ undefinedBehaviors: "" })).toBeNull();
    expect(buildMissionPlanUnitStepContract({ preconditions: 42 })).toBeNull();
    expect(buildMissionPlanUnitStepContract({ postconditions: { nested: true } })).toBeNull();
  });
});
