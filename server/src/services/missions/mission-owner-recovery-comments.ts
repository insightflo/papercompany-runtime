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
const display = (language: SystemLanguage | undefined, ko: string, en: string) => language === "ko" ? ko : en;
export function buildRetrySourceIssueWakeupResultComment(input: {
  language?: SystemLanguage; status: MissionOwnerDecisionWakeupDispatchStatus;
  missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
  /** [observability] not_requested 사유(report_only outcome 의 reason) — 운영자/에이전트 자가 교정용. */
  detailReason?: string | null;
}) {
  const common = {
    language: input.language, missionId: input.missionId, ownerActionIssueId: input.ownerActionIssueId,
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
    display(input.language, "### Mission owner retry wakeup not queued\n재시도 실행 요청이 대기열에 들어가지 않았습니다. 다음 행동: 대기열 결과와 검증 내용을 확인한 뒤 복구를 다시 요청해 주세요.", "### Mission owner retry wakeup not queued\nNo retry wakeup was queued. Check the queue result and validation detail before requesting recovery again."),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Queue result: ${input.status}`,
    input.detailReason ? `Validation detail: ${input.detailReason}` : null,
    `Idempotency key: ${input.idempotencyKey}`,
  ].filter((line): line is string => line !== null).join("\n");
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
  language?: SystemLanguage; missionId: string;
  sourceIssueId: string;
  sourceLabel: string;
  failedRunId: string;
  failedRunStatus: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    display(input.language, "### Mission supervision stale source wakeup dispatched\n이전 실행이 종료되어 복구 실행을 요청했습니다. 다음 행동: 다음 실행 기록을 확인해 주세요. 요청만으로 실제 실행을 확인할 수는 없습니다.", "### Mission supervision stale source wakeup dispatched\nA recovery wakeup was requested after the previous run ended. Check the next run record; this request does not confirm execution."),
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
  language?: SystemLanguage; missionId: string;
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
    display(input.language, "### Mission supervision workProduct-reuse wakeup dispatched\n기존 파일의 산출물 등록을 위한 실행을 요청했습니다. 파일은 있지만 등록과 후속 실행은 아직 확인되지 않았습니다. 다음 행동: 아래 경로를 등록하고 실행 기록을 확인해 주세요.", "### Mission supervision workProduct-reuse wakeup dispatched\nAn artifact-registration wakeup was requested. The file exists, but registration and subsequent execution are not confirmed by this request."),
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
  language?: SystemLanguage; sourceLabel: string;
  childLabel: string;
  evidenceLines: string[];
}) {
  return [
    display(input.language, "### Validator retry evidence\n수정 업무는 완료됐지만 새 검증 결과가 필요합니다. 다음 행동: 아래 근거를 검토하고 PASS 또는 REQUEST_CHANGES를 제출해 주세요.", "### Validator retry evidence\nA correction is complete; validation still needs a new verdict. Review the evidence below before deciding PASS or REQUEST_CHANGES."),
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
    prose(language, "retry_comment_heading"), prose(language, "retry_comment_status"),
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
  language?: SystemLanguage; ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  requestChangesSummary: string;
}) {
  return [
    display(input.language, "### Mission owner retry REQUEST_CHANGES context\n다음 행동: 아래 검증 지적 사항을 수정한 뒤 다시 검토를 요청해 주세요.", "### Mission owner retry REQUEST_CHANGES context\nNext action: address the validation feedback below before requesting another review."),
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
  language?: SystemLanguage; missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    display(input.language, "### Mission owner retry wakeup dispatched\n재시도 실행을 요청했습니다. 이 댓글은 실제 실행을 확인한 기록이 아닙니다.\n다음 행동: 담당 에이전트의 다음 실행 기록을 확인해 주세요.", "### Mission owner retry wakeup dispatched\nThe retry wakeup was requested; execution is not confirmed by this comment.\nNext action: check the target agent's next run record."),
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
  language?: SystemLanguage; missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  return [
    display(input.language, "### Mission owner retry wakeup handled by workflow\n기존 작업 흐름 재개 요청이 이 업무를 이미 포함하여 추가 실행을 요청하지 않았습니다.\n다음 행동: 기존 작업 흐름의 실행 진행 상황을 확인해 주세요.", "### Mission owner retry wakeup handled by workflow\nAn existing workflow resume request already covers this issue; no second wakeup was requested.\nNext action: check the existing workflow run for execution progress."),
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
