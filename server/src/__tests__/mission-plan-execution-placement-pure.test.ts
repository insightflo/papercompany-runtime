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

  const proseCases = ["title", "reason", "expectedOutput", "acceptanceCriteria", "evidenceRequired"]
    .flatMap((field) => [false, true].flatMap((hasDependency) => [
      "Produce HTML index.html with rendering",
      "do NOT accept HTML",
      "Produce Markdown report.md",
    ].map((text) => ({ field, hasDependency, text }))));

  it.each(proseCases)("does not infer kinds from $field: $text (dependency=$hasDependency)", ({ field, hasDependency, text }) => {
    const toolName = "validate-record";
    const context = {
      workflowToolsByName: new Map([[toolName, {
        name: toolName,
        enabled: true,
        planningMetadata: { acceptedInputKinds: ["json"] },
      }]]),
      workflowToolGrantKeys: new Set([`validator-agent:${toolName}`]),
      agentNamesById: new Map([["validator-agent", "Validator"]]),
      agentSkillProfilesById: new Map(),
    };
    const review = (prose: string) => {
      const content = { [field]: ["acceptanceCriteria", "evidenceRequired"].includes(field) ? [prose] : prose };
      return reviewMissionPlanExecutionPlacementWithContext({
        selectedExecutionUnits: [
          ...(hasDependency ? [unit({ id: "producer", ...content })] : []),
          unit({
            id: "qa",
            assigneeAgentId: "validator-agent",
            toolNames: [toolName],
            ...(hasDependency ? { dependsOn: ["producer"] } : content),
          }),
        ],
        context,
      });
    };

    expect(review("Produce the requested record")).toEqual([]);
    expect(review(text)).toEqual([]);
  });

  it.each([
    { enabled: false, knownAgent: true, code: "workflow_tool_disabled" },
    { enabled: true, knownAgent: false, code: "workflow_tool_assignee_unknown" },
  ])("preserves $code regardless of prose", ({ enabled, knownAgent, code }) => {
    const diagnostics = reviewMissionPlanExecutionPlacementWithContext({
      selectedExecutionUnits: [unit({
        id: "qa", title: "do NOT accept HTML", assigneeAgentId: "validator-agent", toolNames: ["validate-record"],
      })],
      context: {
        workflowToolsByName: new Map([["validate-record", { name: "validate-record", enabled }]]),
        workflowToolGrantKeys: new Set(["validator-agent:validate-record"]),
        agentNamesById: new Map(knownAgent ? [["validator-agent", "Validator"]] : []),
        agentSkillProfilesById: new Map(),
      },
    });
    expect(diagnostics).toEqual([expect.objectContaining({ code })]);
  });

  it("does not derive preflight rejection from ACTION prose", () => {
    const diagnostics = reviewDeliveryToolPreflightMarkers([
      unit({
        id: "preflight",
        title: "[CHECK] Resolve input access and delivery prerequisites",
        reason: "Confirm downstream workflow tool access for publish/readback before research starts.",
        graphWorkProductRequired: false,
      }),
      unit({ id: "publish", title: "[ACTION] Publish approved page", toolNames: ["manual-onboarding-publish"] }),
    ]);

    expect(diagnostics).toEqual([]);
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
