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
  return input.status === "workflow_already_dispatched"
    ? buildRetrySourceIssueWakeupHandledByWorkflowComment(common)
    : buildRetrySourceIssueWakeupDispatchedComment(common);
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

export function buildRetrySourceIssueComment(input: {
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  decisionReason?: string;
  requestChangesSummary?: string | null;
}) {
  return [
    "### Mission owner retry applied",
    buildMissionOwnerDecisionAppliedMarker({
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "retry_source_issue",
    }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    "Decision: retry_source_issue",
    "Action: explicit mission-owner retry action moved the source issue back to todo; wakeup dispatch, if requested, is recorded separately.",
    `Reason: ${input.decisionReason ?? "Owner requested source issue retry."}`,
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
