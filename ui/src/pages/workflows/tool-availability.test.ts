import { describe, expect, it } from "vitest";
import { getSelectableWorkflowTools, getWorkflowToolSystemState } from "./tool-availability";

describe("workflow tool availability", () => {
  it("removes inactive tools from selectable workflow choices", () => {
    const tools = getSelectableWorkflowTools([
      {
        name: "collect-evening",
        displayName: "Collect evening",
        description: "Collect evening inputs",
        pluginId: "tool-registry",
        enabled: false,
      },
      {
        name: "publish-report",
        displayName: "Publish report",
        description: "Publish the report",
        pluginId: "tool-registry",
        enabled: true,
      },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(["publish-report"]);
  });

  it("treats the workflow tool system as unavailable when no tool is selectable", () => {
    expect(getWorkflowToolSystemState([], { available: false, reason: "Tool Registry plugin is not installed." })).toEqual({
      available: false,
      reason: "Tool Registry plugin is not installed.",
    });
  });

  it("treats selectable core tools as available despite legacy Tool Registry unavailable state", () => {
    expect(getWorkflowToolSystemState([
      {
        name: "collect-evening",
        displayName: "Collect evening",
        description: "Collect evening inputs",
        pluginId: "",
        source: "core",
        enabled: true,
      },
    ], { available: false, reason: "Tool Registry plugin is not installed." })).toEqual({
      available: true,
    });
  });
});
