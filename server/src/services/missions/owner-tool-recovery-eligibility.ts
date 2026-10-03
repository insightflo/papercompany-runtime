import type { MissionSupervisionIssue, MissionSupervisionMission, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import type { MissionOwnerDecisionRecord } from "./mission-owner-recovery-ledger.js";
import type { MissionOwnerDecisionOption } from "./mission-owner-recovery-events.js";
import { issueLessToolRecoveryOwnsFailure } from "./tool-step-recovery-authority.js";

/** Pure ordered preflight shared by executor and display. Success is NOT locked execution permission. */
export function evaluateOwnerToolRecoverySnapshot(input: {
  mission: Pick<MissionSupervisionMission, "id" | "companyId" | "ownerAgentId">;
  issue: Pick<MissionSupervisionIssue, "originId">;
  sourceIssue: Pick<MissionSupervisionIssue, "originKind"> | null;
  stepRows: MissionSupervisionWorkflowStepRow[];
  decision: MissionOwnerDecisionRecord | null;
  toolCard: boolean; qaCard: boolean; apply: boolean;
}): { kind: "not_applicable" } | { kind: "blocked"; reason: string; outcome: "blocked" | "requires_decision" }
  | { kind: "candidate"; row: MissionSupervisionWorkflowStepRow } {
  const { mission, issue, decision } = input;
  const target = decision?.decision.recoveryTarget ?? null;
  const blocked = (reason: string, outcome: "blocked" | "requires_decision" = "blocked") => ({ kind: "blocked" as const, reason, outcome });
  if (!input.toolCard && target?.kind === "issue") return { kind: "not_applicable" };
  if (!input.toolCard && target?.kind !== "tool_step"
    && (input.qaCard || input.sourceIssue?.originKind !== "mission_main_executor_oversight")) return { kind: "not_applicable" };
  if (!target || target.kind !== "tool_step") return blocked("target_missing", "requires_decision");
  if (!decision || decision.missionId !== mission.id || decision.authorAgentId !== mission.ownerAgentId
    || decision.sourceIssueId !== issue.originId) return blocked("decision_scope_mismatch");
  const matches = input.stepRows.filter(({ run, stepRun }) =>
    run.id === target.workflowRunId && stepRun.id === target.stepRunId
    && stepRun.workflowRunId === target.workflowRunId && run.companyId === mission.companyId && run.missionId === mission.id);
  if (matches.length !== 1) return blocked(matches.length ? "target_ambiguous" : "no_step_run");
  const row = matches[0]!;
  if (row.run.status !== "failed") return blocked("run_not_failed");
  if (row.run.dispatchAuthorityVersion !== target.expectedAuthorityVersion
    || row.stepRun.executionGeneration !== target.expectedExecutionGeneration
    || row.stepRun.lastDispatchRequestId !== target.failedDispatchRequestId) return blocked("stale_generation");
  if (!issueLessToolRecoveryOwnsFailure(row)) return blocked("step_not_retryable");
  if (!input.apply) return blocked("not_requested");
  return { kind: "candidate", row };
}

/** These are the existing branches, not a new policy or a prose-derived action. */
export function toolRecoveryDecisionEffect(decision: MissionOwnerDecisionOption | null) {
  if (decision === "recover_artifact") return "artifact";
  if (decision === "retry_source_issue") return "retry";
  return "no_tool_action";
}
export function ownerDecisionRequestsHuman(decision: MissionOwnerDecisionOption | null) {
  return decision === "request_input" || decision === "escalate";
}
