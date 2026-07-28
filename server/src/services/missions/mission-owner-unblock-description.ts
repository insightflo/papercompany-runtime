import {
  MISSION_OWNER_DECISION_OPTIONS,
  buildMissionOwnerActionMarker,
  buildMissionOwnerDecisionFormat,
} from "./mission-owner-recovery-events.js";
import { prose, type SystemLanguage } from "./system-language.js";

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
    "- Before requesting input or escalating, exhaust safe internal recovery first: retry_source_issue, recover_artifact, reassign_source_issue, replan_mission, or rerun/revalidate tool steps. Apply the least invasive recovery that resolves the blocker with concrete evidence.",
    "Escalation/reporting line:",
    "- If you cannot resolve the blocker because required authority, credentials, human input, external account/API access, or policy decision is missing, do not pretend the mission is recovered.",
    "- Use the existing mission-owner decision path: retry_source_issue, reassign_source_issue, replan_mission, request_input, or escalate. Do not invent a new control-plane action.",
    "- In the decision reason or next-action text, name the next assignee/owner `reportsTo` target that should receive the blocker and the evidence they need.",
    "- request_input and escalate are the LAST resort - use them only when no safe internal recovery exists, or when genuine human/operator authority, credentials, external account/API access, or a policy decision is actually required. Do not escalate merely because the blocker is unclassified.",
    "- When no runnable agent remains in the reporting line, or the blocker requires operator authority, choose request_input/escalate and request human/operator input. The human operator is the final receiver for unresolved mission blockers.",
    "- When escalating, you MUST attach the evidence and specify the concrete next action the operator must perform, and name the owner/audience (`reportsTo` target), so the request is actionable in the Human Operator menu rather than a bare status note.",
    "- Record the judgement, action taken, and next expected state so the mission can continue.",
    "Oversight signal boundary:",
    "- Treat this issue as a wakeup plus basic state/evidence from oversight. Oversight is not the recovery decision-maker.",
    "- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.",
    "- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.",
  ].join("\n");
}

export function buildMissionOwnerUnblockDescription(
  mission: MissionOwnerDescriptionMission,
  blockedIssue: MissionOwnerDescriptionIssue,
  options: { governanceEvidence?: string[]; missionExecutionDigest?: string[]; language?: SystemLanguage } = {},
): string {
  const language = options.language ?? "en";
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
    prose(language, "owner_unblock_signal_intro"),
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
      : prose(language, "owner_unblock_digest_unavailable"),
    "",
    buildMainExecutorBrief({
      missionGoal: mission.title,
      currentSituation: `Source issue ${sourceLabel} is ${blockedIssue.status}; original assignee is ${blockedIssue.assigneeAgentId ?? "unassigned"}.`,
    }),
    "",
    "Decision authority (REQUIRED control path): submit your decision through the structured API, not a comment:",
    `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`,
    "Body schema: { decision: <one of the allowed options>, sourceIssueRef?, reworkTargetRef?, targetAgentId?, reason?, nextAction?, evidence? }",
    "Allowed decision options:",
    ...MISSION_OWNER_DECISION_OPTIONS.map((decision) => `- ${decision}`),
    "When decision is reassign_source_issue, targetAgentId is REQUIRED (UUID of a same-company agent). Free-text nextAction/reason/evidence never assigns the source.",
    "The API records the authoritative structured decision bound to this company/mission/owner-action/source scope. Comments (including any 'Decision:' block below) are DISPLAY-ONLY and can no longer drive recovery — a comment alone changes nothing.",
    "",
    buildMissionOwnerDecisionFormat(),
    "",
    prose(language, "owner_unblock_source_assignment_note"),
    governanceEvidence.length > 0
      ? ["Governance evidence:", ...governanceEvidence.map((line) => `- ${line}`)].join("\n")
      : prose(language, "owner_unblock_governance_unavailable"),
  ].join("\n");
}
