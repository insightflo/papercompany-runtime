import { joinPromptSections } from "./prompt-utils.js";

const CONTRACT_KIND = "workflow_qa_cap_acceptance";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function buildQaCapAcceptanceBriefLines(value: unknown): readonly string[] {
  const contract = asRecord(value);
  if (contract?.kind !== CONTRACT_KIND) return [];

  const qaStepId = asString(contract.qaStepId);
  const producerStepId = asString(contract.producerStepId);
  const currentIteration = asInteger(contract.currentIteration);
  const maxIterations = asInteger(contract.maxIterations);
  const verdictEndpoint = asString(contract.verdictEndpoint);
  if (!qaStepId || !producerStepId || currentIteration === null || maxIterations === null || !verdictEndpoint) return [];

  return [
    "QA cap decision contract:",
    `- Reinspect the current producer generation: ${producerStepId} (${currentIteration}/${maxIterations}) for QA step ${qaStepId}.`,
    "- Submit PASS when every QA criterion is satisfied.",
    "- Treat a remaining gap as blocking only when it creates material risk to safe or useful downstream progress.",
    "- Blocking principles: a missing or unreadable required output; unsafe or materially false content; or a state where downstream consumption, delivery, or verification cannot proceed.",
    "- Do not classify a gap as blocking merely because a checklist item or canonical probe failed. Judge the material consequence, then submit normal REQUEST_CHANGES only when the workflow must remain blocked.",
    joinPromptSections([
      "- Only when remaining limitations do not block safe downstream progress, submit REQUEST_CHANGES through the official endpoint with:",
      '  `nonblockingAcceptance: { "classification": "nonblocking", "limitations": ["specific remaining limitation"] }`',
    ], "\n"),
    `- Official verdict endpoint: ${verdictEndpoint}`,
    "- Do not infer acceptance from comments or transcript text. Only the official workflow verdict API record counts.",
  ];
}
