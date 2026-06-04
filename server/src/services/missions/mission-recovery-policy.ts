export const MISSION_EXCEPTION_TYPES = [
  "failed_run",
  "blocked_issue",
  "stale_issue",
  "missing_evidence",
  "budget_or_policy_stop",
] as const;

export type MissionExceptionType = typeof MISSION_EXCEPTION_TYPES[number];

export const MISSION_RECOVERY_ACTIONS = [
  "retry_same_issue",
  "wake_current_assignee",
  "request_owner_decision",
  "mark_blocked",
  "abort_or_pause_mission",
] as const;

export type MissionRecoveryAction = typeof MISSION_RECOVERY_ACTIONS[number];

export const DEFAULT_MISSION_RECOVERY_ACTIONS_BY_EXCEPTION: Record<MissionExceptionType, MissionRecoveryAction[]> = {
  failed_run: ["retry_same_issue", "request_owner_decision", "abort_or_pause_mission"],
  blocked_issue: ["wake_current_assignee", "request_owner_decision", "mark_blocked"],
  stale_issue: ["wake_current_assignee", "request_owner_decision", "mark_blocked"],
  missing_evidence: ["request_owner_decision", "mark_blocked"],
  budget_or_policy_stop: ["request_owner_decision", "abort_or_pause_mission"],
};

const MISSION_EXCEPTION_TYPE_SET = new Set<string>(MISSION_EXCEPTION_TYPES);
const MISSION_RECOVERY_ACTION_SET = new Set<string>(MISSION_RECOVERY_ACTIONS);

export function isMissionExceptionType(value: unknown): value is MissionExceptionType {
  return typeof value === "string" && MISSION_EXCEPTION_TYPE_SET.has(value);
}

export function isMissionRecoveryAction(value: unknown): value is MissionRecoveryAction {
  return typeof value === "string" && MISSION_RECOVERY_ACTION_SET.has(value);
}

export function allowedRecoveryActionsForException(type: MissionExceptionType): readonly MissionRecoveryAction[] {
  return DEFAULT_MISSION_RECOVERY_ACTIONS_BY_EXCEPTION[type];
}

export function selectDefaultRecoveryAction(input: {
  exceptionType: MissionExceptionType;
  attemptCount?: number | null;
  evidenceAvailable?: boolean | null;
}): MissionRecoveryAction {
  if (input.exceptionType === "missing_evidence" || input.evidenceAvailable === false) {
    return "request_owner_decision";
  }
  if (input.exceptionType === "budget_or_policy_stop") {
    return "request_owner_decision";
  }
  if ((input.attemptCount ?? 0) <= 0 && input.exceptionType === "failed_run") {
    return "retry_same_issue";
  }
  if ((input.exceptionType === "blocked_issue" || input.exceptionType === "stale_issue") && (input.attemptCount ?? 0) <= 0) {
    return "wake_current_assignee";
  }
  return "request_owner_decision";
}
