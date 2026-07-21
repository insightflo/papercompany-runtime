import { describe, expect, it } from "vitest";
import { renderMissionPlanningTemplateLines } from "../services/missions/mission-planning-templates.js";
import type { MissionExecutionCandidate } from "../services/missions/mission-execution-candidates.js";

function candidate(overrides: Partial<MissionExecutionCandidate>): MissionExecutionCandidate {
  return {
    agentId: "agent-1",
    name: "Agent One",
    role: "worker",
    capabilities: null,
    desiredSkillKeys: [],
    toolNames: [],
    ...overrides,
  };
}

function renderLines(input: {
  title: string;
  description: string | null;
  candidates: MissionExecutionCandidate[];
}): string {
  return renderMissionPlanningTemplateLines(input).join("\n");
}

// [ purpose ] The template selector drives case selection off bounded
//   token sets: research tools (research/search/collect/fetch/source),
//   research missions (research/analysis/source gathering/report),
//   durable file missions (file/document/html/pdf/presentation/spreadsheet),
//   publish missions (publish/deploy/upload), and validator tools
//   (validate/validator/verify/check/lint/schema/contract). These tests prove
//   representative tokens from each set are honored. Adding a new token to
//   a set requires adding a representative case here.
describe("mission planning template token selection", () => {
  it("always emits a ## Planning templates parent heading", () => {
    const out = renderLines({
      title: "Generic mission",
      description: null,
      candidates: [candidate({})],
    });
    expect(out).toContain("## Planning templates");
  });

  describe("research tool tokens (research/search/collect/fetch/source)", () => {
    for (const tool of ["deep-research", "web-search", "data-collect", "api-fetch", "doc-source"]) {
      it(`renders the research case for granted tool ${tool}`, () => {
        const out = renderLines({
          title: "Source gathering and analysis",
          description: "Compile a research report.",
          candidates: [candidate({ toolNames: [tool] })],
        });
        expect(out).toContain(tool);
        expect(out).toMatch(/Case template: research and report/i);
      });
    }
  });

  describe("research mission tokens (research/analysis/source gathering/report)", () => {
    for (const title of ["Market analysis", "Source gathering brief", "Weekly research"]) {
      it(`renders the research case for mission title "${title}"`, () => {
        const out = renderLines({
          title,
          description: "Neutral work item.",
          candidates: [candidate({ toolNames: ["research-search"] })],
        });
        expect(out).toMatch(/Case template: research and report/i);
      });
    }
  });

  describe("durable file mission tokens (file/document/html/pdf/presentation/spreadsheet)", () => {
    for (const title of [
      "Author the output file",
      "Author the launch document",
      "Compile the status report",
      "Build the HTML page",
      "Generate the PDF",
      "Produce the quarterly presentation",
      "Compile the budget spreadsheet",
    ]) {
      it(`renders the durable file case for mission title "${title}"`, () => {
        const out = renderLines({
          title,
          description: "Standalone work item.",
          candidates: [candidate({})],
        });
        expect(out).toMatch(/Case template: durable file creation/i);
      });
    }
  });

  describe("publish mission tokens (publish/deploy/upload)", () => {
    for (const title of ["Publish the release", "Deploy the bundle", "Upload the asset"]) {
      it(`renders the manual-onboarding case for mission title "${title}" when both tools are granted`, () => {
        const out = renderLines({
          title,
          description: "Deliver the artifact.",
          candidates: [candidate({ toolNames: ["manual-onboarding-publish", "manual-onboarding-verify"] })],
        });
        expect(out).toMatch(/Case template: manual-onboarding publish and verify/i);
      });
    }
  });

  describe("structural tool tokens (validate/validator/verify/check/lint/schema/contract)", () => {
    for (const tool of ["url-validate", "quality-validator", "result-verify", "status-check", "lint-rules", "schema-guard", "contract-guard"]) {
      it(`renders the structural case for granted tool ${tool}`, () => {
        const out = renderLines({
          title: "Validate the contract",
          description: "Verify machine-checkable constraints.",
          candidates: [candidate({ toolNames: [tool] })],
        });
        expect(out).toContain(tool);
        expect(out).toMatch(/Case template: structural validation gate/i);
      });
    }
  });
});
