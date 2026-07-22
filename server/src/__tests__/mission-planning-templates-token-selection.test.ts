import { describe, expect, it } from "vitest";
import { selectFallbackMissionPlanTemplateKeys } from "../services/missions/mission-planning-templates.js";
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

function selectKeys(input: {
  title: string;
  description: string | null;
  candidates: MissionExecutionCandidate[];
}): string[] {
  return selectFallbackMissionPlanTemplateKeys(input);
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
  describe("research tool tokens (research/search/collect/fetch/source)", () => {
    for (const tool of ["deep-research", "web-search", "data-collect", "api-fetch", "doc-source"]) {
      it(`renders the research case for granted tool ${tool}`, () => {
        const out = selectKeys({
          title: "Source gathering and analysis",
          description: "Compile a research report.",
          candidates: [candidate({ toolNames: [tool] })],
        });
        expect(out).toContain("research-report-qa");
      });
    }
  });

  describe("research mission tokens (research/analysis/source gathering/report)", () => {
    for (const title of ["Market analysis", "Source gathering brief", "Weekly research"]) {
      it(`renders the research case for mission title "${title}"`, () => {
        const out = selectKeys({
          title,
          description: "Neutral work item.",
          candidates: [candidate({ toolNames: ["research-search"] })],
        });
        expect(out).toContain("research-report-qa");
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
        const out = selectKeys({
          title,
          description: "Standalone work item.",
          candidates: [candidate({})],
        });
        expect(out).toContain("durable-file-review");
      });
    }
  });

  describe("publish mission tokens (publish/deploy/upload)", () => {
    for (const title of ["Publish the release", "Deploy the bundle", "Upload the asset"]) {
      it(`renders the manual-onboarding case for mission title "${title}" when both tools are granted`, () => {
        const out = selectKeys({
          title,
          description: "Deliver the artifact.",
          candidates: [candidate({ toolNames: ["manual-onboarding-publish", "manual-onboarding-verify"] })],
        });
        expect(out).toContain("manual-onboarding-publish-verify");
      });
    }
  });

  describe("structural tool tokens (validate/validator/verify/check/lint/schema/contract)", () => {
    for (const tool of ["url-validate", "quality-validator", "result-verify", "status-check", "lint-rules", "schema-guard", "contract-guard"]) {
      it(`renders the structural case for granted tool ${tool}`, () => {
        const out = selectKeys({
          title: "Validate the contract",
          description: "Verify machine-checkable constraints.",
          candidates: [candidate({ toolNames: [tool] })],
        });
        expect(out).toContain("structural-validation-semantic-review");
      });
    }
  });
});
