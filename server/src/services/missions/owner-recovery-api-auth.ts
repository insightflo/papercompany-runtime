// Owner-recovery authorization preserves the existing lock, validation and checkout order.
// Submission normalization is supplied by the API; this module does not write decisions.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { heartbeatRuns, issues, missions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { conflict, forbidden, unauthorized } from "../../errors.js";
import { issueService } from "../issues.js";
import { readOwnerToolIdentity } from "./owner-human-request-authority.js";
import type { OwnerHumanTx } from "./owner-human-request-contract.js";
import { assertOwnerRecoveryTarget } from "./owner-recovery-target.js";
import { toolRecoveryDecisionEffect } from "./owner-tool-recovery-eligibility.js";
import { ownerRecoveryActorFailure, ownerRecoveryIssueFailure, ownerRecoveryOwnerMatches, ownerRecoverySourceMatches, ownerRecoveryIdentityMatches, ownerRecoveryOversightDecisionFailure, ownerRecoveryOversightRunIsActive } from "./owner-recovery-submission-guards.js";
import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";
import type { MissionOwnerDecisionSubmission } from "./mission-owner-recovery-ledger.js";

type OwnerRecoveryApiAuthDependencies = {
  readonly toSubmission: (data: MissionOwnerDecisionSubmit, oversight?: boolean) => MissionOwnerDecisionSubmission;
};

export async function authorizeOwnerRecoveryApi(db: Db, issueId: string, actor: OwnerRecoveryApiActor,
  data: MissionOwnerDecisionSubmit, { toSubmission }: OwnerRecoveryApiAuthDependencies) {
  const actorFailure = ownerRecoveryActorFailure(actor);
  if (actorFailure === "agent_required") throw forbidden("Agent authentication required");
  if (actorFailure === "run_required" || !actor.runId) throw unauthorized("Agent run id required");
  if (!actor.agentId) throw forbidden("Agent authentication required");

  const [issue] = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    missionId: issues.missionId,
    originKind: issues.originKind,
    originId: issues.originId,
    identifier: issues.identifier,
    title: issues.title,
    assigneeAgentId: issues.assigneeAgentId,
    description: issues.description,
  }).from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) return null;
  const isOversight = issue.originKind === "mission_main_executor_oversight";
  const issueFailure = ownerRecoveryIssueFailure(issue);
  if (issueFailure === "unblock_required" && !isOversight) {
    throw conflict("Owner-recovery decision API can only be used for mission-owner unblock issues");
  }
  if (issueFailure === "mission_required") {
    throw conflict("Owner-recovery decision API requires a mission-scoped owner-action issue");
  }
  // Validate decisions and oversight restrictions in this transaction before any checkout adoption.
  toSubmission(data, isOversight);
  const decisionFailure = ownerRecoveryOversightDecisionFailure(issue, data.decision, data.recoveryTarget);
  if (decisionFailure === "decision_not_allowed") {
    throw conflict("Oversight submissions may only request human input or escalate");
  }
  if (decisionFailure === "recovery_target_not_allowed") {
    throw conflict("Oversight submissions cannot include a recovery target");
  }
  // [fail closed] owner-action issue 는 반드시 mission scope 를 가져야 한다. missionId 가 없거나
  //   matching mission row 가 없으면 결정을 영속화하지 않는다(null-mission decision 금지).
  if (!issue.missionId) {
    throw conflict("Owner-recovery decision API requires a mission-scoped owner-action issue");
  }
  const [mission] = await db.select({ ownerAgentId: missions.ownerAgentId, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
    .limit(1).for("update");
  if (isOversight && (mission?.status === "completed" || mission?.status === "cancelled")) {
    throw conflict("Completed or cancelled missions cannot accept oversight submissions");
  }
  if (!ownerRecoveryOwnerMatches(mission, actor.agentId)) {
    throw forbidden("Only the mission owner agent may submit owner-recovery decisions");
  }
  let sourceHidden = false;
  let sourceIssueId: string | null = null;
  let sourceIssueOriginKind: string | null = null;
  let sourceIssueOriginRunId: string | null = null;
  if (!isOversight) {
    sourceIssueId = issue.originId;
    if (!sourceIssueId) {
      throw conflict("Owner-recovery decision API requires a source issue in the same company and mission");
    }
    const [sourceIssue] = await db.select({ missionId: issues.missionId, originKind: issues.originKind, originRunId: issues.originRunId, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, issue.companyId)))
      .limit(1).for("share");
    if (!ownerRecoverySourceMatches(sourceIssue, issue.missionId)) {
      throw conflict("Owner-recovery decision API requires a source issue in the same company and mission");
    }
    sourceHidden = Boolean(sourceIssue.hiddenAt);
    sourceIssueOriginKind = sourceIssue.originKind;
    sourceIssueOriginRunId = sourceIssue.originRunId;
  }
  // Validate every candidate before checkout; human decisions retain optional target semantics.
  const tool = await readOwnerToolIdentity(db as unknown as OwnerHumanTx, issue.companyId, issue.missionId, issue.id);
  if (tool && ((data.recoveryTarget && (data.recoveryTarget.kind !== "tool_step"
    || data.recoveryTarget.workflowRunId !== tool.workflowRunId || data.recoveryTarget.stepRunId !== tool.stepRunId))
    || (toolRecoveryDecisionEffect(data.decision) !== "no_tool_action" && data.recoveryTarget?.kind !== "tool_step"))) {
    throw conflict("Tool recovery decisions require an exact tool-step recovery target", {
      reason: "owner_recovery_tool_target_required",
    });
  }
  // The issuing heartbeat belongs to this owner-action issue, NOT the recovery target.
  // Check before assertCheckoutOwner: it can adopt or repair a stale checkout lock.
  await assertOwnerRecoveryTarget(db, issue.companyId, issue.missionId, data.recoveryTarget);
  const [heartbeat] = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, actor.runId)).limit(1).for("share");
  const [currentIssue] = await db.select().from(issues)
    .where(eq(issues.id, issue.id)).limit(1).for("update");
  if (!ownerRecoveryIdentityMatches({ heartbeat, issue, currentIssue, agentId: actor.agentId })) {
    throw conflict("Owner-recovery submission requires the same company, agent and owner-action heartbeat", {
      reason: "owner_recovery_submission_identity_mismatch",
    });
  }
  if (isOversight && !ownerRecoveryOversightRunIsActive(heartbeat)) {
    throw conflict("Oversight submissions require the current running heartbeat");
  }
  if (tool && (sourceHidden || mission.status === "completed" || mission.status === "cancelled" || currentIssue?.hiddenAt
    || currentIssue?.assigneeAgentId !== mission.ownerAgentId || ["done", "cancelled"].includes(currentIssue.status))) {
    throw conflict("Tool recovery card is no longer an active mission-owner anchor");
  }
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return {
    issue,
    ownerAgentId: mission.ownerAgentId,
    sourceIssueId,
    sourceIssueOriginKind,
    sourceIssueOriginRunId,
    // [D5 anchor] FOR UPDATE 잠금 하의 결정 시점 이슈 상태 — 카드 targetSnapshot 앵커(issueStatus).
    ownerIssueStatus: currentIssue?.status ?? null,
    isOversight,
  };
}
