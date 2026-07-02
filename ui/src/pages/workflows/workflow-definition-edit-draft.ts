import { jsonToSteps, type StepDraft } from "./step-draft.js";
import { formatJsonArrayForForm } from "./workflow-form-utils.js";
import type { StepEditorMode, WorkflowOverviewData } from "./workflow-page-types.js";
import { normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflow-parent-policy.js";

type WorkflowDefinition = WorkflowOverviewData["workflows"][number];

export type WorkflowDefinitionEditDraft = {
  name: string;
  description: string;
  status: string;
  triggerLabels: string;
  labelIds: string[];
  showNewLabelForm: boolean;
  newLabelName: string;
  newLabelColor: string;
  schedule: string;
  maxDailyRuns: string;
  timezone: string;
  projectId: string;
  createParentIssuePolicy: CreateParentIssuePolicy;
  steps: StepDraft[];
  stepMode: StepEditorMode;
  jsonText: string;
  flowInputsText: string;
  flowEnvVariablesText: string;
  testInputPresetsText: string;
};

export function buildWorkflowDefinitionEditDraft(workflow: WorkflowDefinition): WorkflowDefinitionEditDraft {
  const rawWorkflow = workflow as Record<string, unknown>;
  const rawSchedule = rawWorkflow.schedule;
  const rawProjectId = rawWorkflow.projectId;
  const rawTimezone = rawWorkflow.timezone;
  const rawMaxDailyRuns = rawWorkflow.maxDailyRuns;
  const rawCreateParentIssuePolicy = rawWorkflow.createParentIssuePolicy;

  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    triggerLabels: (workflow.triggerLabels ?? []).join(", "),
    labelIds: workflow.labelIds ?? [],
    showNewLabelForm: false,
    newLabelName: "",
    newLabelColor: "#6366f1",
    schedule: typeof rawSchedule === "string" ? rawSchedule : "",
    maxDailyRuns: typeof rawMaxDailyRuns === "number" && Number.isFinite(rawMaxDailyRuns)
      ? String(Math.trunc(rawMaxDailyRuns))
      : "",
    timezone: typeof rawTimezone === "string" && rawTimezone.trim() ? rawTimezone : "Asia/Seoul",
    projectId: typeof rawProjectId === "string" ? rawProjectId : "",
    createParentIssuePolicy: normalizeCreateParentIssuePolicy(rawCreateParentIssuePolicy),
    steps: jsonToSteps(workflow.steps),
    stepMode: "graph",
    jsonText: JSON.stringify(workflow.steps, null, 2),
    flowInputsText: formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowInputs),
    flowEnvVariablesText: formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowEnvVariables),
    testInputPresetsText: formatJsonArrayForForm(workflow.legacyMetadata?.graphTestInputPresets),
  };
}

export function emptyWorkflowDefinitionEditDraft(): WorkflowDefinitionEditDraft {
  return {
    name: "",
    description: "",
    status: "active",
    triggerLabels: "",
    labelIds: [],
    showNewLabelForm: false,
    newLabelName: "",
    newLabelColor: "#6366f1",
    schedule: "",
    maxDailyRuns: "",
    timezone: "Asia/Seoul",
    projectId: "",
    createParentIssuePolicy: "when_multiple_steps",
    steps: [],
    stepMode: "graph",
    jsonText: "",
    flowInputsText: "[]",
    flowEnvVariablesText: "[]",
    testInputPresetsText: "[]",
  };
}
