import { useEffect, useMemo, useState } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowOverviewData } from "../workflow-page-types.js";
import { jsonToSteps, stepsToJson } from "../step-draft.js";
import { renameWorkflowStep } from "../workflow-graph.js";

export function useRawStepJsonEditor({
  selectedStep,
  steps,
  onChange,
  setSelectedStepId,
  setSelectedPathStepIds,
  setGraphError,
}: {
  selectedStep: StepDraft | null;
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  setSelectedStepId: (id: string | null) => void;
  setSelectedPathStepIds: (ids: string[]) => void;
  setGraphError: (error: string) => void;
}) {
  const [rawStepJsonText, setRawStepJsonText] = useState<string>("");
  const [rawStepJsonFeedback, setRawStepJsonFeedback] = useState<{ tone: "info" | "error" | "success"; message: string } | null>(null);

  const selectedRawStepJson = useMemo(
    () => selectedStep ? JSON.stringify(stepsToJson([selectedStep])[0], null, 2) : "",
    [selectedStep],
  );

  useEffect(() => {
    setRawStepJsonText(selectedRawStepJson);
    setRawStepJsonFeedback(null);
  }, [selectedRawStepJson]);

  function parseRawSelectedStepJson(): StepDraft | null {
    if (!selectedStep) return null;
    try {
      const parsed = JSON.parse(rawStepJsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must be one object." });
        return null;
      }
      const [draft] = jsonToSteps([parsed as WorkflowOverviewData["workflows"][number]["steps"][number]]);
      if (!draft?.id.trim()) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must include a non-empty id." });
        return null;
      }
      const duplicate = steps.some((step) => step.id !== selectedStep.id && step.id === draft.id);
      if (duplicate) {
        setRawStepJsonFeedback({ tone: "error", message: `Step id "${draft.id}" already exists.` });
        return null;
      }
      return draft;
    } catch (error) {
      setRawStepJsonFeedback({ tone: "error", message: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  function validateRawSelectedStepJson(): void {
    const parsed = parseRawSelectedStepJson();
    if (!parsed) return;
    setRawStepJsonFeedback({ tone: "success", message: `Valid step JSON for ${parsed.id}.` });
  }

  function applyRawSelectedStepJson(): void {
    if (!selectedStep) return;
    const parsed = parseRawSelectedStepJson();
    if (!parsed) return;
    const renamedSteps = parsed.id !== selectedStep.id
      ? renameWorkflowStep(steps, selectedStep.id, parsed.id)
      : steps;
    onChange(renamedSteps.map((step) => (step.id === parsed.id ? parsed : step)));
    setSelectedStepId(parsed.id);
    setSelectedPathStepIds(parsed.id.trim() ? [parsed.id] : []);
    setRawStepJsonFeedback({ tone: "success", message: `Applied JSON to ${parsed.id}.` });
    setGraphError("");
  }

  return {
    rawStepJsonText,
    rawStepJsonFeedback,
    setRawStepJsonText,
    setRawStepJsonFeedback,
    validateRawSelectedStepJson,
    applyRawSelectedStepJson,
  };
}
