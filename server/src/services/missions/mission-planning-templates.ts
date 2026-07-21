import type { MissionExecutionCandidate } from "./mission-execution-candidates.js";

export type MissionPlanningTemplateInput = {
  readonly title: string;
  readonly description: string | null;
  readonly candidates?: readonly MissionExecutionCandidate[];
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
  return `${input.title}\n${input.description ?? ""}`;
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

function researchReportLines(grantedResearchTools: readonly string[]): string[] {
  const toolList = grantedResearchTools.length > 0
    ? grantedResearchTools.map((name) => `\`${name}\``).join(", ")
    : "";
  return [
    "## Case template: research and report",
    "When the mission outcome requires new findings before producing the deliverable:",
    "- Split source gathering from writing: one unit runs the research tool, downstream units consume its `workProductPath`.",
    "- Declare coverage explicitly: list independent queries or domains as separate units rather than one vague search task.",
    "- The research unit is an ACTION producer (`graphWorkProductRequired: true`) when its output is consumed downstream.",
    toolList ? `- Granted research-capable tools in this roster: ${toolList}. Reference one only on the unit whose assignee holds the grant.` : "- No research-capable tool is granted in this roster; do not invent one.",
  ];
}

function durableFileCreationLines(): string[] {
  return [
    "## Case template: durable file creation",
    "When the mission produces a durable work-product unit (document, PDF, authored artifact):",
    "- The producer unit must set `graphWorkProductRequired: true` and declare the workProduct path as its `expectedOutput`.",
    "- Place a producer -> artifact QA -> final outcome review chain; do not collapse authoring and review into one unit.",
    "- Reference the artifact by `{$steps.<producer-unit-id>.workProductPath}` from downstream units.",
  ];
}

function manualOnboardingLines(): string[] {
  return [
    "## Case template: manual-onboarding publish and verify",
    "When the mission must deliver through manual onboarding and both tools are granted:",
    "- Assign `manual-onboarding-publish` to one unit (the publisher) and `manual-onboarding-verify` to a downstream unit that depends on it.",
    "- The verify unit must consume the registered publish result via `toolArgs.publishResultPath: \"{$steps.<publish-unit-id>.workProductPath}\"`.",
    "- Never substitute a direct curl, guessed URL, or hard-coded destination for the registered publish result reference.",
  ];
}

function structuralLines(grantedValidatorTools: readonly string[]): string[] {
  const toolList = grantedValidatorTools.length > 0
    ? grantedValidatorTools.map((name) => `\`${name}\``).join(", ")
    : "";
  return [
    "## Case template: structural validation gate",
    "When a machine-checkable contract exists and a validator tool is granted, declare a structural tool unit before semantic QA.",
    "- Structural tool unit shape: `type: \"tool\"`, `qaType: \"structural\"`, exactly one `toolName` from the roster grant, `graphWorkProductRequired: false`.",
    "- The gate must return `data.verdict: \"pass\" | \"request_changes\"`. A missing verdict is a hard contract failure.",
    "- Do not invent a validator, encode visible prose as structure, or enforce exact wording. Semantic concerns remain for the agent LLM QA.",
    toolList ? `- Granted validator-like tools in this roster: ${toolList}.` : "- No validator-like tool is granted in this roster; do not invent a structural gate.",
  ];
}

export function renderMissionPlanningTemplateLines(input: MissionPlanningTemplateInput): string[] {
  const text = combineText(input);
  const granted = grantedTools(input);

  const lines: string[] = ["## Planning templates"];
  lines.push(...generalTemplateLines());

  const grantedResearchTools = findGrantedByToken(granted, RESEARCH_TOOL_TOKENS);
  if (grantedResearchTools.length > 0 && hasToken(text, RESEARCH_MISSION_TOKENS)) {
    lines.push("", ...researchReportLines(grantedResearchTools));
  }

  if (hasToken(text, DURABLE_MISSION_TOKENS)) {
    lines.push("", ...durableFileCreationLines());
  }

  const hasPublish = granted.includes(PUBLISH_TOOL);
  const hasVerify = granted.includes(VERIFY_TOOL);
  if (hasPublish && hasVerify && hasToken(text, PUBLISH_MISSION_TOKENS)) {
    lines.push("", ...manualOnboardingLines());
  }

  const grantedValidatorTools = findGrantedByToken(granted, VALIDATOR_TOOL_TOKENS);
  if (grantedValidatorTools.length > 0 && hasToken(text, STRUCTURAL_MISSION_TOKENS)) {
    lines.push("", ...structuralLines(grantedValidatorTools));
  }

  return lines;
}
