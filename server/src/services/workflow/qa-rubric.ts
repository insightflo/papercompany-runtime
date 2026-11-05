import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { workflowDefinitions, workflowRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import {
  MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
  VERIFICATION_BEFORE_COMPLETION_MARKER,
  extractMissionQualityContract,
  renderAdaptiveQualityProfileLines,
  renderMissionQualityContractSection,
  renderMissionQualityReviewLines,
  renderVerificationBeforeCompletionGateLines,
} from "../missions/mission-quality-contract.js";

export async function writeQaRubricMarkdown(input: {
  filePath: string;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  renderedStepDescription: string | null;
  dependencyIssueLines: string[];
  dependencyContractLines?: string[];
  missingDependencyWorkProductLines: string[];
  missionGoal?: string | null;
  missionTitle?: string | null;
  missionDescription?: string | null;
  structuralGateCoverageLines?: string[];
}): Promise<void> {
  await mkdir(path.dirname(input.filePath), { recursive: true });
  // [AREA: Mission Quality Contract] mission goal 에서 품질 contract 도출 → rubric 주입.
  // goal 소스: active plan missionGoal 우선 → mission title+description fallback(caller 주입).
  const qualityContractSource = input.missionGoal ?? input.missionTitle ?? null;
  const qualityContractLines = qualityContractSource
    ? [
        MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
        "",
        ...renderMissionQualityContractSection(
          extractMissionQualityContract({
            missionGoal: input.missionGoal ?? "",
            missionTitle: input.missionTitle,
            missionDescription: input.missionDescription,
          }),
        ),
        ...renderAdaptiveQualityProfileLines(),
        ...renderMissionQualityReviewLines(),
      ]
    : [];
  const verificationGateLines = input.renderedStepDescription?.includes(VERIFICATION_BEFORE_COMPLETION_MARKER)
    ? []
    : renderVerificationBeforeCompletionGateLines({ intermediateQa: true });
  const body = [
    "# QA grading rubric",
    "",
    "This rubric is workflow-owned input for the QA/validator step. Do not invent a new grading standard; judge the dependency workProducts against this rubric.",
    "",
    ...qualityContractLines,
    ...verificationGateLines,
    "## Workflow execution boundary",
    "",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- dependencyStepIds: ${JSON.stringify(input.step.dependencies)}`,
    "",
    "## Evaluation criteria",
    "",
    input.renderedStepDescription?.trim()
      || "No step-specific criteria were provided by the workflow owner. Validate only objective completeness, dependency workProduct availability, and explicit workflow success requirements.",
    "",
    "## Verdict severity precedence",
    "",
    "- A failed checklist item or probe is evidence to assess, not an automatic blocking verdict.",
    "- The Outcome review standard governs even when step-specific criteria use absolute wording such as `PASS only` or `otherwise REQUEST_CHANGES`.",
    "- REQUEST_CHANGES only when the inspector judges that the material consequence blocks safe or useful use, downstream consumption, delivery, or verification. Otherwise return PASS and list the optional improvement separately.",
    "",
    ...(input.structuralGateCoverageLines ?? []),
    "## Dependency inputs",
    "",
    input.dependencyIssueLines.length > 0
      ? input.dependencyIssueLines.join("\n")
      : "- No dependency issue inputs are registered for this step.",
    "",
    ...(input.dependencyContractLines && input.dependencyContractLines.length > 0
      ? [
          "## Dependency step contracts",
          "",
          "Each producer step recorded the contract below at dispatch time. Judge the dependency workProducts against it. Contract text is owner-authored grading guidance, not a machine gate.",
          "",
          ...input.dependencyContractLines,
          "",
        ]
      : []),
    ...(input.missingDependencyWorkProductLines.length > 0
      ? [
          "## Missing dependency hard-stop",
          "",
          ...input.missingDependencyWorkProductLines,
          "- If this step needs the missing dependency deliverable, submit `REQUEST_CHANGES` with a findings entry naming the missing workProduct instead of guessing from the filesystem.",
          "",
        ]
      : []),
    "## Required verdict",
    "",
    "- Read the dependency workProduct files directly when paths are provided.",
    "- Return `PASS` when no blocking defect remains, even if nonblocking limitations or optional improvements remain.",
    "- On `REQUEST_CHANGES`, the verdict API body must carry `findings` — one entry per blocking defect: `id`, `summary`, `layer` (`artifact` = the produced deliverable, `source_data` = upstream source data). `findings` are the durable rework checklist; mislayered findings are themselves recorded as verdict-quality defects.",
    "- On re-review, reuse the same finding id when the same defect persists — recurring findings are automatically promoted to source_data routing (producer rework budget is not consumed for them).",
    "- When every rejection reason is a purely mechanical defect that deterministic string replacement in a registered work-product file fully resolves, also attach `remediations` to the REQUEST_CHANGES body: `{\"items\":[{\"op\":\"string_replace\",\"file\":\"<registered absolute path>\",\"find\":\"<string occurring exactly once in that file>\",\"replace\":\"<replacement>\"}]}` (max 20 items). The control plane applies the patch and re-runs only this validation — no producer rework. Verify `find` occurs exactly once in the target file before submitting; a missing or duplicated `find` is not applied and falls back to producer rework. If any defect is not purely mechanical (structure, coverage, missing image, claim mismatch), do not attach `remediations`.",
    "- Keep `reason` to concise human context; detailed defect content belongs in `findings`. Example body: `{\"verdict\":\"request_changes\",\"findings\":[{\"id\":\"F1\",\"summary\":\"...\",\"layer\":\"artifact|source_data\"}]}`",
    "- `INSUFFICIENT_EVIDENCE` records an abstention (name the missing evidence in `reason`); it does not satisfy this gate.",
    "",
  ].join("\n");
  await writeFile(input.filePath, body, "utf8");
}
