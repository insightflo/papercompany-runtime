import {
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildStaleSourceIssueWakeupDispatchedMarker,
  buildWorkProductReuseWakeDispatchedMarker,
  extractMissionOwnerDecisionFromText,
  type ExtractedMissionOwnerDecision,
} from "./mission-owner-recovery-events.js";
import type { MissionOwnerDecisionWakeupDispatchStatus } from "./supervision-types.js";
import { buildExistingArtifactRegistrationActionLines } from "../work-products/artifact-registration-instructions.js";
import { metadataDigestPath } from "./mission-execution-digest.js";
import { prose, type SystemLanguage } from "./system-language.js";
export { buildMainExecutorBrief, buildMissionOwnerUnblockDescription } from "./mission-owner-unblock-description.js";
export function buildRetrySourceIssueWakeupResultComment(input: {
  status: MissionOwnerDecisionWakeupDispatchStatus;
  missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  const common = {
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    ownerActionLabel: input.ownerActionLabel,
    sourceIssueId: input.sourceIssueId,
    sourceLabel: input.sourceLabel,
    targetAgentId: input.targetAgentId,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.status === "workflow_already_dispatched") {
    return buildRetrySourceIssueWakeupHandledByWorkflowComment(common);
  }
  if (input.status === "dispatched") {
    return buildRetrySourceIssueWakeupDispatchedComment(common);
  }
  return [
    "### Mission owner retry wakeup not queued",
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Queue result: ${input.status}`,
    `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export function extractLatestMissionOwnerDecision(texts: string[]): ExtractedMissionOwnerDecision | null {
  for (const text of texts.slice().reverse()) {
    const decision = extractMissionOwnerDecisionFromText(text);
    if (decision) return decision;
  }
  return null;
}

const REQUEST_CHANGES_SUMMARY_MAX_CHARS = 1600;

function trimRequestChangesSummary(value: string): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= REQUEST_CHANGES_SUMMARY_MAX_CHARS) return normalized;
  return `${normalized.slice(0, REQUEST_CHANGES_SUMMARY_MAX_CHARS).trimEnd()}...`;
}

export function extractLatestRequestChangesSummary(texts: Array<string | null | undefined>): string | null {
  for (const rawText of texts.slice().reverse()) {
    const text = rawText?.trim();
    if (!text) continue;

    const matches = [...text.matchAll(/REQUEST[_\s-]?CHANGES\s*:?\s*/giu)];
    const latestMatch = matches.at(-1);
    if (!latestMatch || latestMatch.index === undefined) continue;

    let summary = text.slice(latestMatch.index).trim();
    const closingFenceIndex = summary.indexOf("\n```");
    if (closingFenceIndex > 0) summary = summary.slice(0, closingFenceIndex).trim();
    const nextHeadingIndex = summary.search(/\n#{1,6}\s/u);
    if (nextHeadingIndex > 0) summary = summary.slice(0, nextHeadingIndex).trim();
    return trimRequestChangesSummary(summary);
  }
  return null;
}

export function buildStaleSourceIssueWakeupDispatchedComment(input: {
  missionId: string;
  sourceIssueId: string;
  sourceLabel: string;
  failedRunId: string;
  failedRunStatus: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    "### Mission supervision stale source wakeup dispatched",
    buildStaleSourceIssueWakeupDispatchedMarker({
      missionId: input.missionId,
      sourceIssueId: input.sourceIssueId,
      failedRunId: input.failedRunId,
      idempotencyKey: input.idempotencyKey,
    }),
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Terminal heartbeat run: ${input.failedRunId} status=${input.failedRunStatus}`,
    `Target agent: ${input.targetAgentId}`,
    `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export function buildWorkProductReuseWakeDispatchedComment(input: {
  missionId: string;
  sourceIssueId: string;
  sourceLabel: string;
  artifactPath: string;
  stalledRecoveryIssueId: string;
  stalledRunId: string;
  stalledRunStatus: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    "### Mission supervision workProduct-reuse wakeup dispatched",
    buildWorkProductReuseWakeDispatchedMarker({
      missionId: input.missionId,
      sourceIssueId: input.sourceIssueId,
      artifactPath: input.artifactPath,
      idempotencyKey: input.idempotencyKey,
    }),
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Blocked: graphWorkProductRequired producer has no registered workProduct, but the deliverable file already exists on disk.`,
    `Recovery issue ${input.stalledRecoveryIssueId} is stalled (heartbeat run ${input.stalledRunId} status=${input.stalledRunStatus}); the registration gap is the only missing step.`,
    `Deliverable file already written: ${input.artifactPath}`,
    `Target agent: ${input.targetAgentId}`,
    `Idempotency key: ${input.idempotencyKey}`,
    ...buildExistingArtifactRegistrationActionLines({ artifactPath: input.artifactPath }),
  ].join("\n");
}

export function buildValidatorRetryEvidenceComment(input: {
  sourceLabel: string;
  childLabel: string;
  evidenceLines: string[];
}) {
  return [
    "### Validator retry evidence",
    `Source issue: ${input.sourceLabel}`,
    `Completed correction issue: ${input.childLabel}`,
    "Re-run the validator against the corrected artifact context below.",
    "",
    ...input.evidenceLines.map((line) => `- ${line}`),
    "",
    "Validation gate:",
    "- Re-check the RES-148 repair spec before deciding PASS.",
    "- Re-check the existing REQUEST_CHANGES objections for panel 3 and panel 5.",
    "- Return only PASS or REQUEST_CHANGES.",
    "- Do not directly modify the artifact from this validator retry.",
    "- Telegram/send is forbidden before PASS.",
    "- If the corrected artifact path is missing, unreadable, or criteria remain ambiguous, return REQUEST_CHANGES with diagnostics.",
  ].join("\n");
}

export function isTerminalIssueStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

export function summarizeOwnerDecisionNotApplied(input: {
  ownerActionLabel: string;
  sourceLabel: string;
  reason: string;
  decision?: string;
}) {
  return `owner_action_decision_not_applied: ${input.ownerActionLabel} ${input.decision ?? "retry_source_issue"} source=${input.sourceLabel} — ${input.reason}`;
}

// [final QA / mission validation owner recovery] retry 가 깨운 source issue 가 받아야 할
//   컨텍스트: (1) 원본 source issue instruction/description, (2) 해당 source issue 의 active
//   workProducts, (3) latest REQUEST_CHANGES feedback. capped mission digest 에 의존하지 않고
//   source-issue scope 에서 직접 읽은 값을 그대로 주입한다. 텍스트/카운트는 bound.
export type SourceRetryWorkProduct = {
  readonly title: string;
  readonly type: string;
  readonly provider: string;
  readonly url: string | null;
  readonly externalId: string | null;
  readonly metadata: Record<string, unknown> | null;
};

export const SOURCE_RETRY_WORK_PRODUCT_MAX = 8;
const SOURCE_INSTRUCTION_MAX_CHARS = 1600;

function trimSourceInstruction(value: string): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= SOURCE_INSTRUCTION_MAX_CHARS) return normalized;
  return `${normalized.slice(0, SOURCE_INSTRUCTION_MAX_CHARS).trimEnd()}...`;
}

function formatSourceRetryWorkProductLine(product: SourceRetryWorkProduct): string {
  const title = product.title.trim() || "(untitled workProduct)";
  const parts = [`type=${product.type}`, `provider=${product.provider}`];
  if (product.url) parts.push(`url=${product.url}`);
  const externalId = product.externalId?.trim() || null;
  if (externalId) parts.push(`externalId=${externalId}`);
  const metadataPath = metadataDigestPath(product.metadata);
  if (metadataPath && metadataPath !== externalId && metadataPath !== product.url) {
    parts.push(`path=${metadataPath}`);
  }
  return `- ${title} (${parts.join(", ")})`;
}

export function buildRetrySourceIssueComment(input: {
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  decisionReason?: string;
  requestChangesSummary?: string | null;
  sourceTitle?: string | null;
  sourceInstruction?: string | null;
  activeWorkProducts?: readonly SourceRetryWorkProduct[];
  language?: SystemLanguage;
}) {
  const titleTrim = input.sourceTitle?.trim() || null;
  const language = input.language ?? "en";
  const trimmedInstruction = input.sourceInstruction?.trim() ? trimSourceInstruction(input.sourceInstruction) : null;
  const instructionBlock = [
    titleTrim ? `Title: ${titleTrim}` : null,
    trimmedInstruction,
  ].filter((line): line is string => line !== null).join("\n\n");
  const products = (input.activeWorkProducts ?? []).slice(0, SOURCE_RETRY_WORK_PRODUCT_MAX);
  return [
    prose(language, "retry_comment_heading"),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    "Decision: retry_source_issue",
    prose(language, "retry_comment_action_line"),
    `Reason: ${input.decisionReason ?? prose(language, "retry_comment_default_reason")}`,
    instructionBlock
      ? [
          "",
          prose(language, "retry_comment_instruction_label"),
          "```text",
          instructionBlock,
          "```",
        ].join("\n")
      : null,
    products.length > 0
      ? [
          "",
          prose(language, "retry_comment_workproducts_label", { count: products.length }),
          ...products.map(formatSourceRetryWorkProductLine),
        ].join("\n")
      : null,
    input.requestChangesSummary
      ? [
          "",
          "Latest REQUEST_CHANGES summary:",
          "```text",
          input.requestChangesSummary,
          "```",
        ].join("\n")
      : null,
  ].filter((line): line is string => line !== null).join("\n");
}
export function buildRetrySourceIssueRequestChangesContextComment(input: {
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  requestChangesSummary: string;
}) {
  return [
    "### Mission owner retry REQUEST_CHANGES context",
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    "Use this latest validation objection when retrying the source issue.",
    "",
    "Latest REQUEST_CHANGES summary:",
    "```text",
    input.requestChangesSummary,
    "```",
  ].join("\n");
}

export function buildRetrySourceIssueWakeupDispatchedComment(input: {
  missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    "### Mission owner retry wakeup dispatched",
    buildMissionOwnerDecisionAppliedMarker({
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "retry_source_issue",
    }),
    buildMissionOwnerDecisionWakeupDispatchedMarker({
      missionId: input.missionId,
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "retry_source_issue",
      idempotencyKey: input.idempotencyKey,
    }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Target agent: ${input.targetAgentId}`,
    `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export function buildRetrySourceIssueWakeupHandledByWorkflowComment(input: {
  missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    "### Mission owner retry wakeup handled by workflow",
    buildMissionOwnerDecisionAppliedMarker({
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "retry_source_issue",
    }),
    buildMissionOwnerDecisionWakeupDispatchedMarker({
      missionId: input.missionId,
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "retry_source_issue",
      idempotencyKey: input.idempotencyKey,
    }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Target agent: ${input.targetAgentId}`,
    "Wakeup: skipped direct mission-owner wake because an existing workflow resume wake already covered this source issue.",
    `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}
