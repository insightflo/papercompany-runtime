import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reviewDeliveryToolPreflightMarkers } from "../services/missions/mission-plan-artifact-contract.js";
import { reviewMissionPlanExecutionPlacementWithContext } from "../services/missions/mission-plan-execution-placement.js";

function unit(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "mission_plan_unit",
    selectionState: "selected",
    sourceRef: { type: "mission_plan_unit", id: overrides.id ?? randomUUID() },
    ...overrides,
  };
}

describe("mission plan execution placement pure checks", () => {
  it("rejects workflow tool grants against the selected unit assignee", () => {
    const diagnostics = reviewMissionPlanExecutionPlacementWithContext({
      selectedExecutionUnits: [unit({
        id: "publish",
        title: "[ACTION] Publish approved concept page",
        assigneeAgentId: "agent-without-publish-grant",
        toolNames: ["manual-onboarding-publish"],
      })],
      context: {
        workflowToolsByName: new Map([["manual-onboarding-publish", { name: "manual-onboarding-publish", enabled: true }]]),
        workflowToolGrantKeys: new Set(["director-agent:manual-onboarding-publish"]),
        agentNamesById: new Map([["agent-without-publish-grant", "Research Scout"]]),
        agentSkillProfilesById: new Map(),
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "workflow_tool_not_granted_to_assignee" }),
    ]);
  });

  it("rejects workflow tool units without an assignee", () => {
    const toolName = "manual-onboarding-publish";
    const diagnostics = reviewMissionPlanExecutionPlacementWithContext({
      selectedExecutionUnits: [unit({ id: "publish", toolNames: [toolName] })],
      context: {
        workflowToolsByName: new Map([[toolName, { name: toolName, enabled: true }]]),
        workflowToolGrantKeys: new Set([`director-agent:${toolName}`]),
        agentNamesById: new Map(),
        agentSkillProfilesById: new Map(),
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "workflow_tool_unit_missing_assignee" }),
    ]);
  });

  it("allows plugin catalog tools when granted to the selected assignee id", () => {
    const toolName = "insightflo.research-workbench:research-search";
    const diagnostics = reviewMissionPlanExecutionPlacementWithContext({
      selectedExecutionUnits: [unit({ id: "research", assigneeAgentId: "research-agent", toolNames: [toolName] })],
      context: {
        workflowToolsByName: new Map([[toolName, { name: toolName, enabled: true }]]),
        workflowToolGrantKeys: new Set([`research-agent:${toolName}`]),
        agentNamesById: new Map([["research-agent", "Research Scout"]]),
        agentSkillProfilesById: new Map(),
      },
    });

    expect(diagnostics).toEqual([]);
  });

  it("rejects ACTION preflight units that re-check downstream workflow tool access", () => {
    const diagnostics = reviewDeliveryToolPreflightMarkers([
      unit({
        id: "preflight",
        title: "[CHECK] Resolve input access and delivery prerequisites",
        reason: "Confirm downstream workflow tool access for publish/readback before research starts.",
        graphWorkProductRequired: false,
      }),
      unit({ id: "publish", title: "[ACTION] Publish approved page", toolNames: ["manual-onboarding-publish"] }),
    ]);

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_delivery_tool_preflight_unit" }),
    ]);
  });

  it("allows ordinary delivery wording without workflow tool access preflight", () => {
    const diagnostics = reviewDeliveryToolPreflightMarkers([
      unit({ id: "publish", title: "[ACTION] Publish approved page", reason: "Publish the validated artifact and verify destination readback." }),
    ]);

    expect(diagnostics).toEqual([]);
  });

  it("allows input check units that explicitly exclude workflow tool grant checks", () => {
    const diagnostics = reviewDeliveryToolPreflightMarkers([
      unit({
        id: "input-check",
        title: "[ACTION] [INPUT] Confirm OfficeCLI source URL, audience, and requested output type",
        reason: "Confirm only source URL, beginner audience, and HTML output inputs. This unit must not verify downstream workflow tool grants or availability.",
        graphWorkProductRequired: false,
      }),
      unit({ id: "publish", title: "[ACTION] Publish approved page", toolNames: ["manual-onboarding-publish"] }),
    ]);

    expect(diagnostics).toEqual([]);
  });
});
