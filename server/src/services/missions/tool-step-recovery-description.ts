import { buildMissionOwnerDecisionFormat } from "./mission-owner-recovery-events.js";
import { buildMainExecutorBrief } from "./mission-owner-recovery-comments.js";
import type { ToolStepFailureClassification } from "./tool-step-failure.js";

export function buildToolStepRecoveryDescription(input: {
  marker: string;
  missionTitle: string;
  workflowName: string;
  workflowRunId: string;
  stepId: string;
  displayStepName: string;
  toolNames: string[];
  classification: ToolStepFailureClassification;
}): string {
  const toolNamesLabel = input.toolNames.length > 0 ? input.toolNames.join(", ") : "(not recorded)";
  return [
    `<!-- ${input.marker} -->`,
    "Mission-owner signal. A tool workflow step failed without a linked execution issue. Automation has not selected a recovery action.",
    "",
    `Mission: ${input.missionTitle}`,
    `Workflow: ${input.workflowName}`,
    `Workflow run: ${input.workflowRunId}`,
    `Step: ${input.stepId} (${input.displayStepName})`,
    `Tool names: ${toolNamesLabel}`,
    `Local signal hint: ${input.classification.className}`,
    `Local retry hint: ${input.classification.retryPolicy}`,
    `Hint rationale: ${input.classification.rationale}`,
    "",
    "Raw evidence:",
    ...(input.classification.evidence.length > 0
      ? input.classification.evidence.map((line) => `- ${line}`)
      : ["- No runtime stderr/stdout/error evidence was captured on the workflow step run."]),
    "",
    buildMainExecutorBrief({
      missionGoal: input.missionTitle,
      currentSituation: `Workflow ${input.workflowName} run ${input.workflowRunId} has failed tool step ${input.stepId}; no linked execution issue owns the failure.`,
    }),
    "",
    "Mission owner decision authority:",
    "- Submit the recovery decision through `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`; a comment cannot authorize recovery.",
    "- `request_input` and `escalate` submitted through that API create the Human Operator handoff.",
    buildMissionOwnerDecisionFormat(),
    "",
    "Manual recovery evidence:",
    "- `recover_artifact` only completes the tool step when its latest structured decision targets this workflow/source scope and an active workProduct is registered through the official workflow API.",
    "- `[ARTIFACT]`, `Status: success`, and ordinary issue comments are display-only evidence; they do not complete or authorize recovery.",
    "",
    "No recovery action has been selected by automation.",
  ].join("\n");
}
