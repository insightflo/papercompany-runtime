import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import {
  GAZUA_MORNING_ANALYSIS_STEP_IDS,
  GAZUA_MORNING_COLLECTION_TOOL_NAMES,
  buildGazuaMorningParallelCollectionSteps,
} from "../services/workflow/gazua-collection-plan.js";

describe("Gazua workflow collection plan", () => {
  it("splits gazua-morning data collection into independent tool roots", () => {
    const existing: WorkflowStep[] = [
      {
        id: "collect-market",
        name: "{$date} 한국시장 모닝 데이터 수집",
        type: "tool",
        agentId: "",
        dependencies: [],
        dependsOn: [],
        toolName: "collect-morning",
        toolNames: ["collect-morning"],
        description: "Positioning Tape Inputs",
      },
      {
        id: "collect-signals",
        name: "{$date} 한국시장 시그널 집계",
        type: "tool",
        agentId: "",
        dependencies: ["collect-market"],
        dependsOn: ["collect-market"],
        toolName: "collect-signals-kr",
        toolNames: ["collect-signals-kr"],
      },
      {
        id: "signal-analysis",
        name: "{$date} 시그널 해석",
        type: "agent",
        agentId: "",
        agentName: "코난",
        dependencies: ["collect-market", "collect-signals"],
        dependsOn: ["collect-market", "collect-signals"],
        tools: ["collect-morning", "collect-signals-kr"],
        toolNames: ["collect-morning", "collect-signals-kr"],
      },
    ];

    const next = buildGazuaMorningParallelCollectionSteps(existing);

    expect(next.some((step) => step.id === "collect-market")).toBe(false);

    const collectionSteps = next.filter((step) =>
      GAZUA_MORNING_COLLECTION_TOOL_NAMES.includes(step.toolName ?? ""),
    );
    expect(collectionSteps).toHaveLength(GAZUA_MORNING_COLLECTION_TOOL_NAMES.length);
    expect(collectionSteps.map((step) => step.toolName)).toEqual(GAZUA_MORNING_COLLECTION_TOOL_NAMES);
    for (const step of collectionSteps) {
      expect(step.type).toBe("tool");
      expect(step.dependencies).toEqual([]);
      expect(step.dependsOn).toEqual([]);
      expect(step.toolNames).toEqual([step.toolName]);
    }

    const collectionStepIds = collectionSteps.map((step) => step.id);
    expect(next.find((step) => step.id === "collect-signals")).toEqual(
      expect.objectContaining({
        dependencies: collectionStepIds,
        dependsOn: collectionStepIds,
        toolName: "collect-signals-kr",
      }),
    );
    expect(next.find((step) => step.id === "signal-analysis")).toEqual(
      expect.objectContaining({
        dependencies: [...collectionStepIds, "collect-signals"],
        dependsOn: [...collectionStepIds, "collect-signals"],
        toolNames: ["collect-signals-kr"],
      }),
    );
    expect(
      GAZUA_MORNING_COLLECTION_TOOL_NAMES.includes(
        next.find((step) => step.id === "signal-analysis")?.toolName ?? "",
      ),
    ).toBe(false);
    expect(next.find((step) => step.id === "signal-analysis")?.description).toContain(
      "Gazua data evidence contract",
    );
    expect(next.find((step) => step.id === "signal-analysis")?.description).toContain(
      "/Users/kwak/Projects/ai/gazua-dashboard/data",
    );
  });

  it("is idempotent after gazua-morning has already been split", () => {
    const alreadySplit: WorkflowStep[] = [
      ...GAZUA_MORNING_COLLECTION_TOOL_NAMES.map((toolName, index) => ({
        id: [
          "collect-premarket-futures",
          "collect-blog-insights",
          "collect-macro-data",
          "collect-metadata",
          "collect-us-stockflow",
          "collect-memory-scfi",
          "collect-hbm-hbf",
          "collect-kr-futures-flow",
          "collect-market-calendar",
        ][index]!,
        name: toolName,
        type: "tool",
        agentId: "",
        dependencies: [],
        dependsOn: [],
        toolName,
        toolNames: [toolName],
      })),
      {
        id: "signal-analysis",
        name: "{$date} 시그널 해석",
        type: "agent",
        agentId: "",
        agentName: "코난",
        dependencies: ["collect-signals"],
        dependsOn: ["collect-signals"],
        description: "Analyze signals.",
      },
    ];

    const next = buildGazuaMorningParallelCollectionSteps(alreadySplit);

    const collectionSteps = next.filter((step) =>
      GAZUA_MORNING_COLLECTION_TOOL_NAMES.includes(step.toolName ?? ""),
    );
    expect(collectionSteps).toHaveLength(GAZUA_MORNING_COLLECTION_TOOL_NAMES.length);
    for (const stepId of GAZUA_MORNING_ANALYSIS_STEP_IDS) {
      const step = next.find((candidate) => candidate.id === stepId);
      if (!step) continue;
      expect(step.description?.match(/Gazua data evidence contract/g)).toHaveLength(1);
    }
  });
});
