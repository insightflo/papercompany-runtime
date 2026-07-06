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
    "Mission owner decision contract:",
    "- If recovery is impossible or human/operator input is required, leave this structured decision block before blocking or stopping.",
    "- Use `Decision: request_input` or `Decision: escalate` so the Human Operator menu receives the handoff.",
    buildMissionOwnerDecisionFormat(),
    "",
    "Manual recovery result contract:",
    "- If you manually rerun or repair this issue-less tool step and it succeeds, leave a final recovery evidence comment before closing this issue.",
    "- Include `### Native tool step recovery result`, `Status: success`, and one standalone `[ARTIFACT]: <absolute path>` line for the generated/reused handoff file.",
    "- Do not rely on ordinary issue completion alone; the workflow engine will use that recovery evidence to mark the tool step completed.",
    "",
    "No recovery action has been selected by automation.",
  ].join("\n");
}
