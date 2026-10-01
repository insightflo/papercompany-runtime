import { describe, expect, it } from "vitest";
import { selectFallbackMissionPlanTemplateKeys, renderMissionPlanningTemplateLines } from "../services/missions/mission-planning-templates.js";
import { classifyWorkflowStepRole } from "../services/workflow-step-role.js";
import { publicationTools } from "./helpers/mission-publication-fixture.js";

const candidates = [{ agentId: "worker", name: "Worker", role: "worker", capabilities: null,
  desiredSkillKeys: [], toolNames: ["alpha", "beta", "schema-check", "research-search"] }];

describe("declarative mission planning template selection", () => {
  it("does not infer templates from mission prose, agent roles or tool names", () => {
    expect(selectFallbackMissionPlanTemplateKeys({ candidates,
      title: "Research report HTML file publish deploy upload validate contract",
      description: "Collect sources and verify machine-checkable schema.",
    })).toEqual([]);
  });

  it("selects the generic publication template using granted validated artifact roles", () => {
    expect(selectFallbackMissionPlanTemplateKeys({ candidates, tools: publicationTools })).toEqual(["publication-verify"]);
    const renamed = publicationTools.map((tool, i) => ({ ...tool, name: `tool-${i}` }));
    expect(selectFallbackMissionPlanTemplateKeys({
      candidates: [{ ...candidates[0], toolNames: renamed.map(tool => tool.name) }], tools: renamed,
    })).toEqual(["publication-verify"]);
  });

  it("does not select publication for missing grants, disabled or malformed declarations", () => {
    expect(selectFallbackMissionPlanTemplateKeys({ candidates: [], tools: publicationTools })).toEqual([]);
    expect(selectFallbackMissionPlanTemplateKeys({ candidates, tools: [publicationTools[0]] })).toEqual([]);
    expect(selectFallbackMissionPlanTemplateKeys({ candidates,
      tools: [publicationTools[0], { ...publicationTools[1], enabled: false }],
    })).toEqual([]);
    expect(selectFallbackMissionPlanTemplateKeys({ candidates, tools: publicationTools.map(tool => ({
      ...tool, adapterConfig: { artifactContract: { role: "publication-verify" } },
    })) })).toEqual([]);
  });

  it("emits example execution roles that survive renaming all display and identity fields", () => {
    const output = renderMissionPlanningTemplateLines({}).join("\n");
    const examples = [...output.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    expect(examples.map(example => classifyWorkflowStepRole({ ...example, id: "opaque", title: "Neutral" })))
      .toEqual(["action", "qa", "oversight"]);
    expect(examples[1].dependsOn).toEqual([examples[0].id]);
  });
});
