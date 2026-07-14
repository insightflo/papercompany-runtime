import type { StepEditorMode } from "./workflow-page-types.js";
import { stepsToJson } from "./step-draft-serialization.js";
import type { StepDraft } from "./step-draft-types.js";

export type StepsToJsonForSaveResult =
  | { steps: unknown[] }
  | { error: string };

export function stepsToJsonForSave(drafts: StepDraft[]): StepsToJsonForSaveResult {
  for (const [index, draft] of drafts.entries()) {
    if (draft.type !== "tool") continue;
    try {
      JSON.parse(draft.toolArgs || "{}");
    } catch (error) {
      const stepLabel = draft.id.trim() || draft.title.trim() || `#${index + 1}`;
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Tool step "${stepLabel}"의 Tool Args JSON 파싱 실패: ${message}` };
    }
  }
  return { steps: stepsToJson(drafts) };
}

export function workflowStepsToJsonForSave(
  mode: StepEditorMode,
  jsonText: string,
  drafts: StepDraft[],
): StepsToJsonForSaveResult {
  if (mode !== "json") return stepsToJsonForSave(drafts);
  try {
    const steps = JSON.parse(jsonText) as unknown;
    return Array.isArray(steps) ? { steps } : { error: "steps는 JSON 배열이어야 합니다." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `JSON 파싱 실패: ${message}` };
  }
}
