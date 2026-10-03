// server/src/services/missions/mission-owner-recovery-agent-api.ts
//
// [목적] mission-owner recovery 결정의 구조적 제출 API 핸들러. 자연어 comment 가 아닌
//   POST /issues/:id/owner-recovery/decision 만 결정을 workflow_transition_events 에 영속화한다.
// [권한] 오직 mission_main_executor_unblock owner-action issue 의 체크아웃된 agent run 만 제출 가능.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { heartbeatRuns, issues, missions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { badRequest, conflict, forbidden, unauthorized } from "../../errors.js";
import { issueService } from "../issues.js";
import { assertOwnerRecoveryTarget } from "./owner-recovery-target.js";
import { ownerDecisionRequestsHuman } from "./owner-tool-recovery-eligibility.js";
import { ownerRecoveryActorFailure, ownerRecoveryIssueFailure, ownerRecoveryOwnerMatches, ownerRecoverySourceMatches, ownerRecoveryIdentityMatches } from "./owner-recovery-submission-guards.js";
import {
  recordMissionOwnerDecision,
  type MissionOwnerDecisionSubmission,
  type RecordedMissionOwnerDecision,
} from "./mission-owner-recovery-ledger.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "./mission-owner-recovery-events.js";
import {
  materializeHumanOperatorRequestEvent,
  publishHumanOperatorRequestEvent,
} from "./human-operator-alert-events.js";
import { completeUnblockActionWithSourceHandback } from "./owner-action-completion.js";
import { extractQaCapProducerIssueRef, isQaReworkCapOversightIssue } from "./qa-rework-cap-oversight.js";

export type OwnerRecoveryApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

function toSubmission(data: MissionOwnerDecisionSubmit): MissionOwnerDecisionSubmission {
  const trimmed = (value: string | null | undefined): string | undefined => {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized ? normalized : undefined;
  };
  if (!MISSION_OWNER_DECISION_OPTIONS.includes(data.decision)) {
    throw conflict(`Unsupported mission owner decision: ${data.decision}`);
  }
  const targetAgentId = trimmed(data.targetAgentId);
  return {
    decision: data.decision,
    ...(data.recoveryTarget ? { recoveryTarget: data.recoveryTarget } : {}),
    ...(trimmed(data.sourceIssueRef) ? { sourceIssueRef: trimmed(data.sourceIssueRef) } : {}),
    ...(trimmed(data.reworkTargetRef) ? { reworkTargetRef: trimmed(data.reworkTargetRef) } : {}),
    // Structured reassignment authority only — free-text nextAction/reason never supplies the assignee.
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(trimmed(data.reason) ? { reason: trimmed(data.reason) } : {}),
    ...(trimmed(data.nextAction) ? { nextAction: trimmed(data.nextAction) } : {}),
    ...(trimmed(data.evidence) ? { evidence: trimmed(data.evidence) } : {}),
  };
}

export async function authorizeOwnerRecoveryApi(db: Db, issueId: string, actor: OwnerRecoveryApiActor,
  recoveryTarget?: MissionOwnerDecisionSubmit["recoveryTarget"]) {
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
  if (ownerRecoveryIssueFailure(issue) === "unblock_required") {
    throw conflict("Owner-recovery decision API can only be used for mission-owner unblock issues");
  }
  // [fail closed] owner-action issue 는 반드시 mission scope 를 가져야 한다. missionId 가 없거나
  //   matching mission row 가 없으면 결정을 영속화하지 않는다(null-mission decision 금지).
  if (!issue.missionId) {
    throw conflict("Owner-recovery decision API requires a mission-scoped owner-action issue");
  }
  const [mission] = await db.select({ ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
    .limit(1).for("update");
  if (!ownerRecoveryOwnerMatches(mission, actor.agentId)) {
    throw forbidden("Only the mission owner agent may submit owner-recovery decisions");
  }
  const sourceIssueId = issue.originId;
  if (!sourceIssueId) {
    throw conflict("Owner-recovery decision API requires a source issue in the same company and mission");
  }
  const [sourceIssue] = await db.select({
    missionId: issues.missionId,
    originKind: issues.originKind,
  })
    .from(issues)
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, issue.companyId)))
    .limit(1).for("share");
  if (!ownerRecoverySourceMatches(sourceIssue, issue.missionId)) {
    throw conflict("Owner-recovery decision API requires a source issue in the same company and mission");
  }
  // The issuing heartbeat belongs to this owner-action issue, NOT the recovery target.
  // Check before assertCheckoutOwner: it can adopt or repair a stale checkout lock.
  await assertOwnerRecoveryTarget(db, issue.companyId, issue.missionId, recoveryTarget);
  const [heartbeat] = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, actor.runId)).limit(1).for("share");
  const [currentIssue] = await db.select().from(issues)
    .where(eq(issues.id, issue.id)).limit(1).for("update");
  if (!ownerRecoveryIdentityMatches({ heartbeat, issue, currentIssue, agentId: actor.agentId })) {
    throw conflict("Owner-recovery submission requires the same company, agent and owner-action heartbeat", {
      reason: "owner_recovery_submission_identity_mismatch",
    });
  }
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return {
    issue,
    ownerAgentId: mission.ownerAgentId,
    sourceIssueId,
    sourceIssueOriginKind: sourceIssue.originKind,
  };
}

export async function submitMissionOwnerDecision(input: {
  readonly db: Db;
  readonly issueId: string;
  readonly actor: OwnerRecoveryApiActor;
  readonly data: MissionOwnerDecisionSubmit;
}): Promise<RecordedMissionOwnerDecision> {
  // Authorization, checkout adoption and decision insertion must roll back together.
  const committed = await input.db.transaction(async (tx) => {
    const auth = await authorizeOwnerRecoveryApi(tx as unknown as Db, input.issueId, input.actor, input.data.recoveryTarget);
    if (!auth) throw conflict("Owner-recovery decision API can only be used for mission-owner unblock issues");
    const { issue, ownerAgentId, sourceIssueId, sourceIssueOriginKind } = auth;
    const submission = toSubmission(input.data);
    // Existing QA-cap producer resolution is unchanged by this tool-target slice.
    let effectiveSubmission = submission;
    if (submission.decision === "retry_source_issue" && isQaReworkCapOversightIssue(issue.description)) {
      const explicitTarget = (submission.reworkTargetRef ?? submission.sourceIssueRef ?? "").trim();
      if (!explicitTarget) {
        const derivedProducerRef = extractQaCapProducerIssueRef(issue.description);
        if (derivedProducerRef) {
          effectiveSubmission = { ...submission, reworkTargetRef: derivedProducerRef };
        } else {
          throw badRequest(
            'retry_source_issue on a QA rework-cap oversight issue requires "reworkTargetRef" (the producer issue id or identifier). It could not be derived from the issue description — include it explicitly and resubmit.',
          );
        }
      }
    }
    const needsHumanAlert = ownerDecisionRequestsHuman(effectiveSubmission.decision);
    let humanPayload: Awaited<ReturnType<typeof materializeHumanOperatorRequestEvent>>["payload"] = null;
    let humanInserted = false;
    const recorded = await recordMissionOwnerDecision({
      db: tx,
      issue: { id: issue.id, companyId: issue.companyId, missionId: issue.missionId! },
      submission: effectiveSubmission,
      sourceIssueId,
      heartbeatRunId: input.actor.runId,
    });
    if (needsHumanAlert) {
      const materialized = await materializeHumanOperatorRequestEvent(tx as unknown as Db, {
        issue,
        record: { eventId: recorded.eventId, authorAgentId: ownerAgentId },
        decision: effectiveSubmission,
      });
      humanPayload = materialized.payload;
      humanInserted = materialized.inserted;
    }
    return { recorded, humanInserted, humanPayload, issue, sourceIssueOriginKind, submission };
  });
  const { recorded, humanInserted, humanPayload, issue, sourceIssueOriginKind, submission } = committed;
  if (humanInserted && humanPayload) {
    publishHumanOperatorRequestEvent(issue.companyId, humanPayload);
  }
  // This is the point where INF-181 had both durable authorities but no handback. Issue-less tool
  // recovery remains owned by supervision; only a workflow-backed source resumes here.
  if (
    submission.decision === "recover_artifact"
    && submission.recoveryTarget?.kind !== "tool_step"
    && sourceIssueOriginKind === "workflow_execution"
  ) {
    await completeUnblockActionWithSourceHandback(input.db, {
      unblockIssueId: issue.id,
      companyId: issue.companyId,
      actor: { agentId: input.actor.agentId },
      workflowSyncSource: "mission_owner_recovery",
    });
  }
  return recorded;
}
