import { describe, expect, it } from "vitest";
import {
  allowedRecoveryActionsForException,
  isMissionExceptionType,
  isMissionRecoveryAction,
  MISSION_EXCEPTION_TYPES,
  MISSION_RECOVERY_ACTIONS,
  selectDefaultRecoveryAction,
} from "../services/missions/mission-recovery-policy.js";

describe("mission recovery policy", () => {
  it("keeps self-healing bounded to a small exception and action vocabulary", () => {
    expect(MISSION_EXCEPTION_TYPES).toEqual([
      "failed_run",
      "blocked_issue",
      "stale_issue",
      "missing_evidence",
      "budget_or_policy_stop",
    ]);
    expect(MISSION_RECOVERY_ACTIONS).toEqual([
      "retry_same_issue",
      "wake_current_assignee",
      "request_owner_decision",
      "mark_blocked",
      "abort_or_pause_mission",
    ]);
    expect(isMissionExceptionType("validator_report_missing")).toBe(false);
    expect(isMissionRecoveryAction("create_validator_issue")).toBe(false);
  });

  it("maps exceptions to limited recovery actions with owner escalation as fallback", () => {
    expect(allowedRecoveryActionsForException("failed_run")).toEqual([
      "retry_same_issue",
      "request_owner_decision",
      "abort_or_pause_mission",
    ]);
    expect(selectDefaultRecoveryAction({ exceptionType: "failed_run", attemptCount: 0 })).toBe("retry_same_issue");
    expect(selectDefaultRecoveryAction({ exceptionType: "failed_run", attemptCount: 2 })).toBe("request_owner_decision");
    expect(selectDefaultRecoveryAction({ exceptionType: "missing_evidence" })).toBe("request_owner_decision");
    expect(selectDefaultRecoveryAction({ exceptionType: "blocked_issue", attemptCount: 0 })).toBe("wake_current_assignee");
  });
});
