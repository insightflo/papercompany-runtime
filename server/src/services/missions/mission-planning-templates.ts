import type { MissionExecutionCandidate } from "./mission-execution-candidates.js";

export type MissionPlanningTemplateInput = {
  readonly title?: string;
  readonly description?: string | null;
  readonly candidates?: readonly MissionExecutionCandidate[];
  readonly catalog?: readonly MissionPlanningTemplateCatalogItem[];
};

export type MissionPlanningTemplateCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly selectionDescription: string;
  readonly instructions?: string;
};

const PUBLISH_TOOL = "manual-onboarding-publish";
const VERIFY_TOOL = "manual-onboarding-verify";

const RESEARCH_TOOL_TOKENS = ["research", "search", "collect", "fetch", "source"];
const VALIDATOR_TOOL_TOKENS = ["validate", "validator", "verify", "check", "lint", "schema", "contract"];
const RESEARCH_MISSION_TOKENS = ["research", "analysis", "source gathering", "sources", "report"];
const DURABLE_MISSION_TOKENS = ["file", "document", "report", "html", "pdf", "presentation", "spreadsheet"];
const PUBLISH_MISSION_TOKENS = ["publish", "deploy", "upload"];
const STRUCTURAL_MISSION_TOKENS = ["validate", "validation", "contract", "schema", "machine-checkable"];

function hasToken(text: string, tokens: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function combineText(input: MissionPlanningTemplateInput): string {
  return `${input.title ?? ""}\n${input.description ?? ""}`;
}

function grantedTools(input: MissionPlanningTemplateInput): string[] {
  const set = new Set<string>();
  for (const candidate of input.candidates ?? []) {
    for (const name of candidate.toolNames) {
      if (name.trim().length > 0) set.add(name.trim());
    }
  }
  return [...set];
}

function findGrantedByToken(granted: readonly string[], tokens: readonly string[]): string[] {
  return granted.filter((name) => hasToken(name, tokens));
}

function generalTemplateLines(): string[] {
  const actionUnit = {
    id: "unit-action-1",
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

  return [
    "## General planning template",
    "Use this shape for every mission. Always include at least one ACTION unit producing the deliverable and one QA unit that validates it.",
    "- Every unit declares `id`, `assigneeAgentId`, `expectedOutput`, `acceptanceCriteria`, `evidenceRequired`, `sourceRef`, `dependsOn`, `toolNames`, `toolArgs`, `knowledgeBaseIds`, `skillRefs`, and `graphWorkProductRequired`.",
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
  const text = combineText(input);
  const granted = grantedTools(input);
  const selected: string[] = [];

  if (findGrantedByToken(granted, RESEARCH_TOOL_TOKENS).length > 0 && hasToken(text, RESEARCH_MISSION_TOKENS)) {
    selected.push("research-report-qa");
  }
  if (hasToken(text, DURABLE_MISSION_TOKENS)) selected.push("durable-file-review");
  if (granted.includes(PUBLISH_TOOL) && granted.includes(VERIFY_TOOL) && hasToken(text, PUBLISH_MISSION_TOKENS)) {
    selected.push("manual-onboarding-publish-verify");
  }
  if (findGrantedByToken(granted, VALIDATOR_TOOL_TOKENS).length > 0 && hasToken(text, STRUCTURAL_MISSION_TOKENS)) {
    selected.push("structural-validation-semantic-review");
  }
  return selected;
}
