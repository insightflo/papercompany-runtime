import { describe, expect, it } from "vitest";
import { resolveMissionPlanTemplateSelection } from "../services/missions/mission-plan-template-selection.js";

const enabled = [
  { id: "11111111-1111-4111-8111-111111111111", key: "research-report-qa", name: "Research", instructions: "Research body" },
  { id: "22222222-2222-4222-8222-222222222222", key: "durable-file-review", name: "File", instructions: "File body" },
];

describe("resolveMissionPlanTemplateSelection", () => {
  it("uses an explicit agent selection instead of fallback", () => {
    const result = resolveMissionPlanTemplateSelection({
      decision: { selectedPlanTemplateIds: [enabled[1]!.id] },
      enabledTemplates: enabled,
      fallbackKeys: [enabled[0]!.key],
    });
    expect(result).toMatchObject({ ok: true, selectionSource: "agent" });
    if (result.ok) expect(result.templates.map((item) => item.id)).toEqual([enabled[1]!.id]);
  });

  it("treats an explicit empty array as an intentional no-template selection", () => {
    const result = resolveMissionPlanTemplateSelection({
      decision: { selectedPlanTemplateIds: [] },
      enabledTemplates: enabled,
      fallbackKeys: [enabled[0]!.key],
    });
    expect(result).toMatchObject({ ok: true, selectionSource: "agent", templates: [] });
  });

  it("uses code fallback only when the agent omitted the field", () => {
    const result = resolveMissionPlanTemplateSelection({
      decision: {},
      enabledTemplates: enabled,
      fallbackKeys: [enabled[0]!.key],
    });
    expect(result).toMatchObject({ ok: true, selectionSource: "code_fallback" });
    if (result.ok) expect(result.templates.map((item) => item.key)).toEqual([enabled[0]!.key]);
  });

  it("fails closed for malformed, duplicate, disabled, or foreign ids", () => {
    for (const selectedPlanTemplateIds of [
      "not-an-array",
      [enabled[0]!.id, enabled[0]!.id],
      ["33333333-3333-4333-8333-333333333333"],
      ["not-a-uuid"],
    ]) {
      const result = resolveMissionPlanTemplateSelection({
        decision: { selectedPlanTemplateIds },
        enabledTemplates: enabled,
        fallbackKeys: [],
      });
      expect(result.ok).toBe(false);
    }
  });
});
