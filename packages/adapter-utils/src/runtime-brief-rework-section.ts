import { joinPromptSections } from "./prompt-utils.js";

const REWORK_CONTRACT_KIND = "workflow_qa_rework";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function truncateBriefLine(value: string, max = 520): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

export function buildWorkflowReworkContractBriefLines(value: unknown): readonly string[] {
  const contract = asRecord(value);
  if (contract?.kind !== REWORK_CONTRACT_KIND) return [];

  const producerStepId = asString(contract.producerStepId);
  const iterationLabel = asString(contract.iterationLabel);
  const qaFeedbacks = Array.isArray(contract.qaFeedbacks)
    ? contract.qaFeedbacks.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  if (!producerStepId || qaFeedbacks.length === 0) return [];

  const dependencyArtifacts = asString(contract.dependencyArtifacts);
  const requiredActions = asStringArray(contract.requiredActions);
  return [
    "Workflow rework contract:",
    `- Rework target: ${producerStepId}${iterationLabel ? ` (${iterationLabel})` : ""}`,
    "- Current run priority: resolve the latest REQUEST_CHANGES below before registering artifacts or completing the issue.",
    ...requiredActions.slice(0, 4).map((action) => `- Required: ${truncateBriefLine(action, 260)}`),
    ...qaFeedbacks.slice(0, 4).flatMap((feedback, index) => {
      const qaStepId = asString(feedback.qaStepId) ?? `qa-${index + 1}`;
      const qaIssueId = asString(feedback.qaIssueId);
      const body = asString(feedback.feedback) ?? "No QA feedback text was recorded.";
      return [
        `- QA feedback ${index + 1}: ${qaStepId}${qaIssueId ? ` (${qaIssueId})` : ""}`,
        `  ${truncateBriefLine(body)}`,
      ];
    }),
    dependencyArtifacts
      ? joinPromptSections(["- Current dependency artifacts:", truncateBriefLine(dependencyArtifacts, 900)], "\n")
      : null,
  ].filter((line): line is string => line !== null);
}
