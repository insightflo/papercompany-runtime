import { parseObject } from "../adapters/utils.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";

export function hasWorkflowQaReworkContract(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const reworkContract = parseObject(contextSnapshot?.paperclipWorkflowReworkContract);
  return readNonEmptyString(reworkContract.kind) === "workflow_qa_rework";
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;
  if (hasWorkflowQaReworkContract(contextSnapshot)) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "mission_owner_planning_issue_created" ||
    wakeReason === "mission_unblock_action_created" ||
    wakeReason === "mission_unblock_action_stalled"
  ) return true;
  return false;
}

export function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";
  if (hasWorkflowQaReworkContract(contextSnapshot)) return "workflow QA rework requires a fresh session";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === "mission_unblock_action_created") return "wake reason is mission_unblock_action_created";
  if (wakeReason === "mission_unblock_action_stalled") return "wake reason is mission_unblock_action_stalled";
  return null;
}
