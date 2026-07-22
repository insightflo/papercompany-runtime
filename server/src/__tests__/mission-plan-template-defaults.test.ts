import { describe, expect, it } from "vitest";
import { DEFAULT_MISSION_PLAN_TEMPLATES } from "../services/missions/mission-plan-template-defaults.js";

describe("default mission plan templates", () => {
  it("carries the deep-research quality contract into the research template", () => {
    const research = DEFAULT_MISSION_PLAN_TEMPLATES.find((template) => template.key === "research-report-qa");

    expect(research?.instructions).toMatch(/source breadth and depth/i);
    expect(research?.instructions).toMatch(/contradictory, negative, or missing evidence/i);
    expect(research?.instructions).toMatch(/fact, inference, and uncertainty/i);
    expect(research?.instructions).toMatch(/independent QA/i);
  });
});
