import type { MissionExecutionCandidate } from "./mission-execution-candidates.js";
import { hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";

export type MissionPlanningTemplateInput = {
  readonly title?: string;
  readonly description?: string | null;
  readonly candidates?: readonly MissionExecutionCandidate[];
  readonly tools?: readonly PlanningArtifactTool[];
  readonly catalog?: readonly MissionPlanningTemplateCatalogItem[];
};

export type MissionPlanningTemplateCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly selectionDescription: string;
  readonly instructions?: string;
};

function grantedTools(input: MissionPlanningTemplateInput): string[] {
  const set = new Set<string>();
  for (const candidate of input.candidates ?? []) {
    for (const name of candidate.toolNames) {
      if (name.trim().length > 0) set.add(name.trim());
    }
  }
  return [...set];
}

function generalTemplateLines(): string[] {
  const actionUnit = {
    id: "unit-action-1",
    type: "action",
    kind: "mission_plan_unit",
    title: "Concrete ACTION title derived from the mission outcome",
    assigneeAgentId: "<roster-agent-id>",
    selectionState: "selected",
    reason: "Why this unit is necessary for the mission outcome",
    expectedOutput: "Observable output consumed by a downstream unit or final user",
    acceptanceCriteria: ["Criteria specific to this action and mission type"],
    evidenceRequired: ["Proof surface and evidence needed to verify the criteria"],
    sourceRef: { type: "mission_plan_unit", id: "unit-action-1" },
    dependsOn: [] as string[],
    toolNames: [] as string[],
    toolArgs: {},
    knowledgeBaseIds: [] as string[],
    skillRefs: [] as string[],
    graphWorkProductRequired: true,
  };
  const qaUnit = {
    id: "unit-qa-1",
    type: "qa",
    qaType: "semantic",
    kind: "mission_plan_unit",
    title: "[QA] Validate the produced action result against its acceptance criteria",
    assigneeAgentId: "<roster-agent-id>",
    selectionState: "selected",
    reason: "Why this review is necessary and which result it validates",
    expectedOutput: "Evidence-backed quality verdict",
    acceptanceCriteria: ["Verify the upstream action's declared acceptance criteria"],
    evidenceRequired: ["Fresh evidence from the declared proof surface"],
    sourceRef: { type: "mission_plan_unit", id: "unit-qa-1" },
    dependsOn: ["unit-action-1"],
    toolNames: [] as string[],
    toolArgs: {},
    knowledgeBaseIds: [] as string[],
    skillRefs: [] as string[],
    graphWorkProductRequired: false,
  };

  const oversightUnit = {
    ...qaUnit,
    id: "unit-oversight-1",
    type: "oversight",
    qaType: undefined,
    title: "Review exceptions and coordinate recovery",
    assigneeAgentId: "<mission-owner-agent-id>",
    reason: "Handle escalation without replacing the declared QA verdict",
    expectedOutput: "Recorded recovery or escalation decision",
    acceptanceCriteria: ["Resolve the reported exception within the mission policy"],
    evidenceRequired: ["Durable exception and recovery records"],
    sourceRef: { type: "mission_plan_unit", id: "unit-oversight-1" },
    dependsOn: ["unit-qa-1"],
    triggerOn: "escalation",
  };

  return [
    "## General planning template",
    "Use this shape for every mission. Always include at least one ACTION unit producing the deliverable and one QA unit that validates it.",
    "- Every unit declares `id`, `type` (action, qa, or oversight), `assigneeAgentId`, `expectedOutput`, `acceptanceCriteria`, `evidenceRequired`, `sourceRef`, `dependsOn`, `toolNames`, `toolArgs`, `knowledgeBaseIds`, `skillRefs`, and `graphWorkProductRequired`.",
    "- ACTION units that produce an official deliverable set `graphWorkProductRequired: true`; pure condition, input-check, and QA units set `graphWorkProductRequired: false`.",
    "- The QA unit must use `dependsOn` to reference the ACTION unit id it validates.",
    "- `toolArgs: {}` is always valid; populate it only when the tool requires runtime arguments.",
    "- `toolNames`, `knowledgeBaseIds`, and `skillRefs` must come from the candidate roster grant; never invent values.",
    "",
    "ACTION unit example:",
    "```json",
    JSON.stringify(actionUnit, null, 2),
    "```",
    "",
    "QA unit example:",
    "```json",
    JSON.stringify(qaUnit, null, 2),
    "```",
    "",
    "Optional OVERSIGHT unit example (mission-owner escalation only):",
    "```json",
    JSON.stringify(oversightUnit, null, 2),
    "```",
  ];
}

export function renderMissionPlanningTemplateLines(input: MissionPlanningTemplateInput): string[] {
  const lines: string[] = ["## Planning templates"];
  lines.push(...generalTemplateLines());
  if ((input.catalog?.length ?? 0) > 0) {
    lines.push("", "## Available case-template catalog");
    for (const template of input.catalog ?? []) {
      lines.push(`- ${template.name} — ${template.selectionDescription} (id: ${template.id})`);
    }
  }
  return lines;
}

export function selectFallbackMissionPlanTemplateKeys(input: MissionPlanningTemplateInput): string[] {
  const unit = { toolNames: grantedTools(input) };
  const tools = input.tools ?? [];
  return hasPlanArtifactRole(unit, tools, "publication") && hasPlanArtifactRole(unit, tools, "publication-verify")
    ? ["publication-verify"] : [];
  // Other cases require explicit selectedPlanTemplateIds; prose is never authority.
}
