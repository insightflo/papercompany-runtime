import { describe, expect, it } from "vitest";
import { buildMissionPlanningDescription } from "../services/missions/mission-planning-description.js";
import { renderMissionPlanningTemplateLines } from "../services/missions/mission-planning-templates.js";
import { buildPlanQaReviewDescription } from "../services/missions/mission-plan-review-description.js";

const catalog = [{
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research → report → QA",
  selectionDescription: "Use for fresh research and a reviewed report.",
  instructions: "SECRET FULL TEMPLATE BODY",
}];

describe("mission planning template catalog", () => {
  it("always renders the general template and only compact catalog metadata", () => {
    const output = renderMissionPlanningTemplateLines({ catalog }).join("\n");
    expect(output).toContain("## General planning template");
    expect(output).toContain(catalog[0]!.id);
    expect(output).toContain(catalog[0]!.name);
    expect(output).toContain(catalog[0]!.selectionDescription);
    expect(output).not.toContain(catalog[0]!.instructions);
  });

  it("tells the agent how to inspect and select templates in the same planning run", () => {
    const output = buildMissionPlanningDescription({
      companyId: "company-1",
      missionId: "mission-1",
      title: "Research the topic",
      description: "Produce a report.",
      planTemplateCatalog: catalog,
      runnableRosterLines: ["- owner"],
    });
    expect(output).toContain("/api/companies/company-1/mission-plan-templates/11111111-1111-4111-8111-111111111111");
    expect(output).toContain("selectedPlanTemplateIds");
    expect(output).toContain("explicit empty array when no case template applies");
    expect(output).not.toContain(catalog[0]!.instructions);
  });

  it("shows the exact resolved template body to PLAN-QA", () => {
    const output = buildPlanQaReviewDescription({
      missionTitle: "Research",
      missionDescription: null,
      selectedPlanTemplates: [{
        id: catalog[0]!.id,
        name: catalog[0]!.name,
        instructions: catalog[0]!.instructions,
      }],
    });
    expect(output).toContain(catalog[0]!.id);
    expect(output).toContain(catalog[0]!.instructions);
  });
});
