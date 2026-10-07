import type { Db } from "@paperclipai/db";
import type { MissionPlanConsumerDiagnostic, MissionPlanConsumerDiagnosticFields } from "@paperclipai/shared/types/mission-plan-consumer";
import type { RecordLatestAuthorizedMissionOwnerPlanDecisionResult } from "../mission-owner-plan-decisions.js";
import type { MissionOwnerSupervisionAppliedAction } from "./supervision-types.js";
import { logActivity } from "../activity-log.js";

/** Keep the rejection observation durable without changing submission status/retry eligibility.
 * Initial preParsed submissions already persist rejection diagnostics in their submission wrapper.
 */
export async function recordMissionPlanDependencyRejection(input: {
  db: Db; companyId: string; missionId: string; submissionId: string | null;
  planningIssueId: string | null; commentId: string | null; decisionHash: string;
  diagnostics: MissionPlanConsumerDiagnostic[];
}) {
  const result = { status: "invalid" as const, reason: "invalid_dependency_graph",
    planningIssueId: input.planningIssueId, commentId: input.commentId,
    decisionHash: input.decisionHash, diagnostics: input.diagnostics };
  if (input.submissionId) {
    await logActivity(input.db, {
      companyId: input.companyId, actorType: "system", actorId: "mission-plan-qa",
      action: "mission.plan.rejected", entityType: "mission", entityId: input.missionId,
      details: { submissionId: input.submissionId, planningIssueId: input.planningIssueId,
        decisionHash: input.decisionHash, reason: result.reason, diagnostics: result.diagnostics },
    });
  }
  return result;
}

/** Output only: recording the verdict and consuming the plan are distinct results. */
export function projectMissionPlanConsumerResult(result: RecordLatestAuthorizedMissionOwnerPlanDecisionResult): MissionPlanConsumerDiagnosticFields {
  return { planDecisionReason: "reason" in result ? result.reason : null,
    planDecisionDiagnostics: result.diagnostics };
}

export function buildMaterializePlanDecisionAction(missionId: string,
  result: RecordLatestAuthorizedMissionOwnerPlanDecisionResult,
  workflowRunId: string | null): Extract<MissionOwnerSupervisionAppliedAction, { type: "materialize_plan_decision" }> {
  return { type: "materialize_plan_decision", missionId, resultStatus: result.status,
    planningIssueId: result.planningIssueId, ...(workflowRunId ? { workflowRunId } : {}),
    ...projectMissionPlanConsumerResult(result) };
}

export function formatMissionPlanConsumerDiagnostics(fields: MissionPlanConsumerDiagnosticFields): string {
  const parts = [fields.planDecisionReason,
    ...fields.planDecisionDiagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)].filter(Boolean);
  return parts.length ? ` — ${parts.join("; ")}` : "";
}

/** Structured activity details -> display summary only. Never read this text back for control. */
export function missionPlanDiagnosticActivitySummary(action: string, details: Record<string, unknown>): string {
  if (action !== "mission.plan.rejected" && action !== "issue.mission_plan_qa_verdict_submitted") return action;
  const reason = action === "mission.plan.rejected" ? details.reason : details.planDecisionReason;
  const diagnostics = action === "mission.plan.rejected" ? details.diagnostics : details.planDecisionDiagnostics;
  const fields: MissionPlanConsumerDiagnosticFields = { planDecisionReason: typeof reason === "string" ? reason : null,
    planDecisionDiagnostics: Array.isArray(diagnostics) ? diagnostics.filter((entry): entry is MissionPlanConsumerDiagnostic =>
      typeof entry === "object" && entry !== null && typeof entry.code === "string" && typeof entry.message === "string") : [] };
  return action + formatMissionPlanConsumerDiagnostics(fields);
}
