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
  const producerIssueInstruction = asString(contract.producerIssueInstruction);
  const producerWorkProducts = Array.isArray(contract.producerWorkProducts)
    ? contract.producerWorkProducts.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  return [
    "Workflow rework contract:",
    `- Rework target: ${producerStepId}${iterationLabel ? ` (${iterationLabel})` : ""}`,
    "- Current run priority: resolve the latest REQUEST_CHANGES below before registering artifacts or completing the issue.",
    ...requiredActions.slice(0, 4).map((action) => `- Required: ${truncateBriefLine(action, 260)}`),
    producerIssueInstruction ? `- Original issue instruction: ${truncateBriefLine(producerIssueInstruction, 500)}` : null,
    producerWorkProducts.length > 0
      ? joinPromptSections([
          "- Your prior work products on this issue (verify, update, or re-register):",
          ...producerWorkProducts.slice(0, 8).map((wp) => `  - ${asString(wp.title) ?? "artifact"} → ${asString(wp.ref) ?? "(no ref)"}`),
        ], "\n")
      : null,
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

// [QA rework context reduction] rework 계약가 있으면 brief 선두에 올라가는 compact 최우선 블록.
//   긴 runtime/issue 컨텍스트보다 먼저 보이게 해서 producer가 rework를 무시하고 complete 하는 사고(GAZ-265 케이스) 방지.
//   최신 QA 실패 1줄 + 필수 수정 + dependency ref + closeout 금지만 담는다(중복 원문/코멘트는 배제).
export function buildWorkflowReworkTaskHeader(value: unknown): readonly string[] {
  const contract = asRecord(value);
  if (contract?.kind !== REWORK_CONTRACT_KIND) return [];

  const producerStepId = asString(contract.producerStepId);
  const iterationLabel = asString(contract.iterationLabel);
  const qaFeedbacks = Array.isArray(contract.qaFeedbacks)
    ? contract.qaFeedbacks.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  if (!producerStepId || qaFeedbacks.length === 0) return [];

  // [주의] 최신 QA 실패만 선두에 노출(과거 feedback은 상세 섹션에서).
  const latestQa = qaFeedbacks[qaFeedbacks.length - 1];
  const latestQaStepId = asString(latestQa.qaStepId) ?? "qa";
  const latestQaIssueId = asString(latestQa.qaIssueId);
  const latestFeedback = asString(latestQa.feedback) ?? "No QA feedback text was recorded.";

  const dependencyArtifacts = asString(contract.dependencyArtifacts);
  const requiredActions = asStringArray(contract.requiredActions);
  const producerIssueInstruction = asString(contract.producerIssueInstruction);
  const producerWorkProducts = Array.isArray(contract.producerWorkProducts)
    ? contract.producerWorkProducts.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];

  return [
    "=== CURRENT REWORK TASK (highest priority — resolve before anything else) ===",
    `- Target step: ${producerStepId}${iterationLabel ? ` | iteration ${iterationLabel}` : ""}`,
    `- Latest QA failure (${latestQaStepId}${latestQaIssueId ? ` ${latestQaIssueId}` : ""}): ${truncateBriefLine(latestFeedback, 600)}`,
    ...requiredActions.slice(0, 3).map((action) => `- Required: ${truncateBriefLine(action, 220)}`),
    producerIssueInstruction ? `- Original instruction: ${truncateBriefLine(producerIssueInstruction, 300)}` : null,
    producerWorkProducts.length > 0
      ? `- Own prior products: ${producerWorkProducts.slice(0, 4).map((wp) => `${asString(wp.title) ?? "artifact"}→${truncateBriefLine(asString(wp.ref) ?? "", 120)}`).join("; ")}`
      : null,
    dependencyArtifacts ? `- Dependency artifacts: ${truncateBriefLine(dependencyArtifacts, 400)}` : null,
    "- FORBIDDEN: do NOT call /workflow/complete or mark done until the REQUEST_CHANGES above is resolved and the artifact is updated or re-registered.",
    "=== end rework task ===",
  ].filter((line): line is string => line !== null);
}
