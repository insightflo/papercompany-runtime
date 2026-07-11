import {
  EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
  MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
  extractMissionQualityContract,
  renderAdaptiveQualityProfileLines,
  renderMissionQualityContractSection,
} from "./mission-quality-contract.js";
import { renderUntrustedMissionRequestLines } from "./mission-request-prompt-boundary.js";

export type PlanQaReviewDescriptionInput = {
  readonly missionTitle: string;
  readonly missionDescription: string | null;
  readonly missionGoal?: string | null;
};

export function buildPlanQaReviewDescription(input: PlanQaReviewDescriptionInput): string {
  const qualityContract = extractMissionQualityContract({
    missionGoal: input.missionGoal ?? input.missionTitle,
    missionTitle: input.missionTitle,
    missionDescription: input.missionDescription,
  });

  return [
    "Plan QA review gate. The mission owner plan decision is on hold until this review passes.",
    "The original mission request is the source of truth. Review whether this plan can produce a usable, evidence-backed outcome for that request.",
    "",
    ...renderUntrustedMissionRequestLines({ title: input.missionTitle, description: input.missionDescription }),
    `- owner goal restatement: ${input.missionGoal?.trim() || "(not supplied)"}`,
    "",
    MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
    "",
    ...renderMissionQualityContractSection(qualityContract),
    ...renderAdaptiveQualityProfileLines(),
    "## Review method",
    "- Infer the relevant quality profile from the original request. Do not reuse a manual, research, software, or proposal checklist when that profile does not fit.",
    "- Do not invent requirements or preferences that the user did not state and that professional or regulatory constraints do not require.",
    "- Trace every required mission outcome to concrete execution units, assigned resources, action acceptance criteria, QA evidence, and final proof.",
    "- Verify resource feasibility against the runtime planning dossier: assignee role, tool grants, skills, knowledge bases, permissions, inputs, and work systems.",
    "- Judge sequencing and parallelism from real dependencies. Independent work should not be serialized, and dependent work must consume an explicit upstream output.",
    "- Require ACTION QA only where a consequential unit output needs validation, integration QA where outputs must combine, and final outcome review where the mission must be observed in its receiving system.",
    `- ${EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE}`,
    "",
    "## Verdict standard",
    "PASS when the plan is fit for the original purpose, executable with available resources, and specific enough that required outcomes can be verified.",
    "REQUEST_CHANGES only for a blocking defect that can prevent a usable result, execution, or verification.",
    "Non-blocking improvements must be listed separately as suggestions and must not trigger another planning loop.",
    "When requesting changes, identify the exact broken connection and the smallest required correction. Do not ask for a generally more detailed plan.",
    "",
    "Blocking defect classes:",
    "- intent_gap: a required outcome from the original request has no execution path.",
    "- outcome_gap: success or unacceptable failure cannot be observed.",
    "- resource_gap: an assigned agent lacks a required tool, skill, permission, input, or work-system path.",
    "- action_contract_gap: a required unit lacks a usable output, acceptance criterion, or evidence requirement.",
    "- dependency_gap: ordering prevents an output from reaching its consumer or final delivery.",
    "- quality_gap: the selected mission-specific quality profile omits a criterion necessary for safe or useful use.",
    "- verification_gap: a required completion claim has no suitable proof surface.",
    "",
    "Official verdict API (required before completing):",
    "POST `/api/issues/<this PLAN-QA issue id>/mission-plan-qa/verdict` with `{ \"verdict\": \"pass\", \"diagnostics\": [] }` or `{ \"verdict\": \"request_changes\", \"diagnostics\": [...] }`.",
    "Use the API result as the official verdict. Do not use `/workflow/verdict`; this is a mission_plan_qa issue, not a workflow_execution issue.",
    "Fallback/parser compatibility: also finish your run output with exactly one standalone final line: `PASS` or `REQUEST_CHANGES: <specific blocking gaps>`.",
  ].join("\n");
}
