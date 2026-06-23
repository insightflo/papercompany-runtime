import { describe, expect, it } from "vitest";
import { disconnectSteps, type WorkflowGraphStep } from "./workflow-graph";

describe("workflow graph helpers", () => {
  it("removes a selected edge dependency and its edge metadata", () => {
    const steps: WorkflowGraphStep[] = [
      { id: "collect", title: "Collect" },
      {
        id: "synthesize",
        title: "Synthesize",
        dependsOn: "collect, scout",
        graphEdgeMetadata: {
          collect: { kind: "conditional", label: "ready" },
          scout: { kind: "conditional", label: "fallback" },
        },
      },
    ];

    const next = disconnectSteps(steps, "collect", "synthesize");

    expect(next[1]?.dependsOn).toBe("scout");
    expect(next[1]?.graphEdgeMetadata).toEqual({ scout: { kind: "conditional", label: "fallback", condition: "" } });
  });
});
