import { describe, expect, it } from "vitest";
import {
  createMissionPlanTemplateSchema,
  duplicateMissionPlanTemplateSchema,
  updateMissionPlanTemplateSchema,
} from "./mission-plan-template.js";

describe("mission plan template validators", () => {
  it("trims valid create fields", () => {
    expect(createMissionPlanTemplateSchema.parse({
      name: "  Research report  ",
      selectionDescription: "  Use for fresh research.  ",
      instructions: "  Split research, synthesis, and QA.  ",
    })).toEqual({
      name: "Research report",
      selectionDescription: "Use for fresh research.",
      instructions: "Split research, synthesis, and QA.",
    });
  });

  it("enforces bounded non-empty fields", () => {
    expect(() => createMissionPlanTemplateSchema.parse({
      name: " ",
      selectionDescription: "x",
      instructions: "x",
    })).toThrow();
    expect(() => createMissionPlanTemplateSchema.parse({
      name: "x".repeat(121),
      selectionDescription: "x",
      instructions: "x",
    })).toThrow();
    expect(() => createMissionPlanTemplateSchema.parse({
      name: "x",
      selectionDescription: "x".repeat(501),
      instructions: "x",
    })).toThrow();
    expect(() => createMissionPlanTemplateSchema.parse({
      name: "x",
      selectionDescription: "x",
      instructions: "x".repeat(16_001),
    })).toThrow();
  });

  it("accepts a strict non-empty update patch", () => {
    expect(updateMissionPlanTemplateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateMissionPlanTemplateSchema.parse({ name: " Updated " })).toEqual({ name: "Updated" });
    expect(() => updateMissionPlanTemplateSchema.parse({})).toThrow();
    expect(() => updateMissionPlanTemplateSchema.parse({ enabled: true, origin: "custom" })).toThrow();
  });

  it("allows an optional duplicate name only", () => {
    expect(duplicateMissionPlanTemplateSchema.parse({})).toEqual({});
    expect(duplicateMissionPlanTemplateSchema.parse({ name: "  Copy  " })).toEqual({ name: "Copy" });
    expect(() => duplicateMissionPlanTemplateSchema.parse({ enabled: false })).toThrow();
  });
});
