import {
  MISSION_OWNER_DECISION_OPTIONS,
  buildMissionOwnerActionMarker,
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionFormat,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildStaleSourceIssueWakeupDispatchedMarker,
  extractMissionOwnerDecisionFromText,
  type ExtractedMissionOwnerDecision,
} from "./mission-owner-recovery-events.js";

type MissionOwnerDescriptionMission = {
  id: string;
  title: string;
};

type MissionOwnerDescriptionIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

export function buildMainExecutorBrief(input: {
  missionGoal: string;
  currentSituation: string;
}): string {
  return [
    "Main executor brief:",
    "Main executor role:",
    "- You own mission execution. Your goal is to complete the mission, not merely classify the alert.",
    `Mission goal: ${input.missionGoal}`,
    `Current situation: ${input.currentSituation}`,
    "Mission execution loop:",
    "- Inspect the mission goal, plan, workflow/step state, issue tree, comments, work products, and run logs.",
    "- Analyze the reported error or blocked state. If evidence is incomplete, state what is unknown and what must be checked next.",
    "- Choose and perform the action that best advances the mission: instruct or wake agents, request fixes, retry/resume bounded work, request/re-run tool steps, revalidate outputs, replan, escalate, or report impossible completion with evidence.",
    "- Record the judgement, action taken, and next expected state so the mission can continue.",
    "Oversight signal boundary:",
    "- Treat this issue as a wakeup plus basic state/evidence from oversight. Oversight is not the recovery decision-maker.",
    "- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.",
    "- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.",
  ].join("\n");
}

export function extractLatestMissionOwnerDecision(texts: string[]): ExtractedMissionOwnerDecision | null {
  for (const text of texts.slice().reverse()) {
    const decision = extractMissionOwnerDecisionFromText(text);
    if (decision) return decision;
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
}) {
  return `owner_action_decision_not_applied: ${input.ownerActionLabel} retry_source_issue source=${input.sourceLabel} — ${input.reason}`;
}

export function buildRetrySourceIssueComment(input: {
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  decisionReason?: string;
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

export function buildMissionOwnerUnblockDescription(
  mission: MissionOwnerDescriptionMission,
  blockedIssue: MissionOwnerDescriptionIssue,
  options: { governanceEvidence?: string[]; missionExecutionDigest?: string[] } = {},
): string {
  const sourceLabel = blockedIssue.identifier ?? blockedIssue.id;
  const missionExecutionDigest = (options.missionExecutionDigest ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const governanceEvidence = (options.governanceEvidence ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [
    buildMissionOwnerActionMarker({
      missionId: mission.id,
      sourceIssueId: blockedIssue.id,
      actionType: "unblock",
      status: "decision_required",
    }),
    "Mission-owner signal from oversight. This is a wakeup plus basic state/evidence; the main executor must judge and act to complete the mission.",
    "",
    `Mission id: ${mission.id}`,
    `Mission title: ${mission.title}`,
    `Source issue id: ${blockedIssue.id}`,
    `Source issue identifier: ${sourceLabel}`,
    `Source issue title: ${blockedIssue.title}`,
    `Source issue status: ${blockedIssue.status}`,
    `Original assignee agent: ${blockedIssue.assigneeAgentId ?? "unassigned"}`,
    "",
    missionExecutionDigest.length > 0
      ? ["Mission execution digest:", ...missionExecutionDigest.map((line) => `- ${line}`)].join("\n")
      : "Mission execution digest: unavailable for this owner action template.",
    "",
    buildMainExecutorBrief({
      missionGoal: mission.title,
      currentSituation: `Source issue ${sourceLabel} is ${blockedIssue.status}; original assignee is ${blockedIssue.assigneeAgentId ?? "unassigned"}.`,
    }),
    "",
    "Optional structured decision labels for logs/UI hints only; do not treat them as the primary control path:",
    ...MISSION_OWNER_DECISION_OPTIONS.map((decision) => `- ${decision}`),
    "",
    buildMissionOwnerDecisionFormat(),
    "",
    "Source issue remains assigned to the original executor unless this comment explicitly chooses reassign_source_issue.",
    governanceEvidence.length > 0
      ? ["Governance evidence:", ...governanceEvidence.map((line) => `- ${line}`)].join("\n")
      : "Governance evidence: latest evidence unavailable for this owner action template.",
  ].join("\n");
}
