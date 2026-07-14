import { workflowStepsToJsonForSave, type StepDraft } from "./step-draft.js";
import { buildWorkflowInterfaceMetadata, normalizeMaxDailyRunsInput } from "./workflow-form-utils.js";
import type { StepEditorMode, WorkflowOverviewData } from "./workflow-page-types.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";

export type WorkflowDefinitionEditPatch = {
  name: string;
  description: string;
  status: string;
  triggerLabels: string[];
  labelIds: string[];
  steps: unknown[];
  schedule: string;
  maxDailyRuns: number | undefined;
  timezone: string;
  projectId: string;
  createParentIssuePolicy: CreateParentIssuePolicy;
  legacyMetadata: Record<string, unknown>;
};

type BuildWorkflowDefinitionEditPatchInput = {
  name: string;
  description: string;
  status: string;
  triggerLabels: string;
  labelIds: string[];
  schedule: string;
  maxDailyRuns: string;
  timezone: string;
  projectId: string;
  createParentIssuePolicy: CreateParentIssuePolicy;
  editStepMode: StepEditorMode;
  editJsonText: string;
  editingSteps: StepDraft[];
  currentLegacyMetadata: WorkflowOverviewData["workflows"][number]["legacyMetadata"] | undefined;
  flowInputsText: string;
  flowEnvVariablesText: string;
  testInputPresetsText: string;
};

type BuildWorkflowDefinitionEditPatchResult =
  | { patch: WorkflowDefinitionEditPatch }
  | { error: string };

export function buildWorkflowDefinitionEditPatch(
  input: BuildWorkflowDefinitionEditPatchInput,
): BuildWorkflowDefinitionEditPatchResult {
  const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(input.maxDailyRuns);
  if (parsedMaxDailyRuns.error) {
    return { error: parsedMaxDailyRuns.error };
  }

  const serializedSteps = workflowStepsToJsonForSave(input.editStepMode, input.editJsonText, input.editingSteps);
  if ("error" in serializedSteps) return { error: serializedSteps.error };
  const steps = serializedSteps.steps;

  const legacyMetadata = buildWorkflowInterfaceMetadata(
    input.currentLegacyMetadata,
    input.flowInputsText,
    input.flowEnvVariablesText,
    input.testInputPresetsText,
  );
  if (legacyMetadata.error) {
    return { error: legacyMetadata.error };
  }

  return {
    patch: {
      name: input.name,
      description: input.description.trim(),
      status: input.status.trim() || "active",
      triggerLabels: input.triggerLabels.split(",").map((label) => label.trim()).filter(Boolean),
      labelIds: input.labelIds.map((label) => label.trim()).filter(Boolean),
      steps,
      schedule: input.schedule.trim(),
      maxDailyRuns: parsedMaxDailyRuns.value,
      timezone: input.timezone.trim(),
      projectId: input.projectId.trim(),
      createParentIssuePolicy: input.createParentIssuePolicy,
      legacyMetadata: legacyMetadata.value,
    },
  };
}
