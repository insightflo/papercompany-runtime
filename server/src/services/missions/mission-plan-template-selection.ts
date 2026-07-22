import { createHash } from "node:crypto";

export type SelectableMissionPlanTemplate = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly instructions: string;
};

export type ResolvedMissionPlanTemplate = SelectableMissionPlanTemplate & {
  readonly contentHash: string;
};

export type MissionPlanTemplateSelectionResult =
  | { ok: true; selectionSource: "agent" | "code_fallback"; templates: ResolvedMissionPlanTemplate[] }
  | { ok: false; diagnostics: Array<{ code: "plan_template_selection_invalid"; message: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveMissionPlanTemplateSelection(input: {
  readonly decision: Record<string, unknown>;
  readonly enabledTemplates: readonly SelectableMissionPlanTemplate[];
  readonly fallbackKeys: readonly string[];
}): MissionPlanTemplateSelectionResult {
  const explicit = Object.prototype.hasOwnProperty.call(input.decision, "selectedPlanTemplateIds");
  const byId = new Map(input.enabledTemplates.map((template) => [template.id, template]));
  const byKey = new Map(input.enabledTemplates.map((template) => [template.key, template]));
  let selected: SelectableMissionPlanTemplate[];

  if (explicit) {
    const value = input.decision.selectedPlanTemplateIds;
    if (!Array.isArray(value) || value.length > 20 || !value.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
      return { ok: false, diagnostics: [{ code: "plan_template_selection_invalid", message: "selectedPlanTemplateIds must be an array of at most 20 template UUIDs" }] };
    }
    if (new Set(value).size !== value.length) {
      return { ok: false, diagnostics: [{ code: "plan_template_selection_invalid", message: "selectedPlanTemplateIds must not contain duplicates" }] };
    }
    selected = value.map((id) => byId.get(id)).filter((template): template is SelectableMissionPlanTemplate => Boolean(template));
    if (selected.length !== value.length) {
      return { ok: false, diagnostics: [{ code: "plan_template_selection_invalid", message: "One or more selected plan templates are disabled or outside this company" }] };
    }
  } else {
    selected = [...new Set(input.fallbackKeys)]
      .map((key) => byKey.get(key))
      .filter((template): template is SelectableMissionPlanTemplate => Boolean(template));
  }

  return {
    ok: true,
    selectionSource: explicit ? "agent" : "code_fallback",
    templates: selected.map((template) => ({
      ...template,
      contentHash: createHash("sha256").update(template.instructions).digest("hex"),
    })),
  };
}
