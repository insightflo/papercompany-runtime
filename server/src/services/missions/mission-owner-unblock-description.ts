import {
  MISSION_OWNER_DECISION_OPTIONS,
  buildMissionOwnerActionMarker,
  buildMissionOwnerDecisionFormat,
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
    "Escalation/reporting line:",
    "- If you cannot resolve the blocker because required authority, credentials, human input, external account/API access, or policy decision is missing, do not pretend the mission is recovered.",
    "- Use the existing mission-owner decision path: retry_source_issue, reassign_source_issue, replan_mission, request_input, or escalate. Do not invent a new control-plane action.",
    "- In the decision reason or next-action text, name the next assignee/owner `reportsTo` target that should receive the blocker and the evidence they need.",
    "- When no runnable agent remains in the reporting line, or the blocker requires operator authority, choose request_input/escalate and request human/operator input. The human operator is the final receiver for unresolved mission blockers.",
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
