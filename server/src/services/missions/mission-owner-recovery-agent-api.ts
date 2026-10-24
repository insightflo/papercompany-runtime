// Structured owner-recovery submission. Authorization/checkout and all durable request facts
// commit together. Card creation retains its existing post-commit recovery boundary.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { badRequest, conflict, HttpError } from "../../errors.js";
import { ownerDecisionRequestsHuman } from "./owner-tool-recovery-eligibility.js";
import { authorizeOwnerRecoveryApi as authorizeOwnerRecoveryApiWithDependencies } from "./owner-recovery-api-auth.js";
import {
  recordMissionOwnerDecision,
  type RecordedMissionOwnerDecision,
} from "./mission-owner-recovery-ledger.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "./mission-owner-recovery-events.js";
import { publishHumanOperatorRequestEvent } from "./human-operator-alert-events.js";
import { completeUnblockActionWithSourceHandback } from "./owner-action-completion.js";
import { extractQaCapProducerIssueRef, isQaReworkCapOversightIssue } from "./qa-rework-cap-oversight.js";
import { createMissionOwnerHumanInputDecisionCard } from "./mission-owner-human-input-card.js";
import {
  lockOwnerHumanSubmission,
  recordOwnerHumanSubmission,
  type OwnerHumanSubmissionInput,
} from "./owner-human-request-submit.js";

export type OwnerRecoveryApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

export type SubmittedMissionOwnerDecision = RecordedMissionOwnerDecision & {
  readonly lifetimeId?: string;
  readonly humanRequest?: NonNullable<MissionOwnerDecisionSubmit["humanRequest"]>;
  readonly operatorDecisionId?: string;
};

function toSubmission(data: MissionOwnerDecisionSubmit, oversight = false): OwnerHumanSubmissionInput {
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
    ...(data.humanRequest ? { humanRequest: data.humanRequest } : {}),
    ...(data.recoveryTarget ? { recoveryTarget: data.recoveryTarget } : {}),
    ...(!oversight && trimmed(data.sourceIssueRef) ? { sourceIssueRef: trimmed(data.sourceIssueRef) } : {}),
    ...(!oversight && trimmed(data.reworkTargetRef) ? { reworkTargetRef: trimmed(data.reworkTargetRef) } : {}),
    // Only the structured reassignment field supplies an assignee.
    ...(!oversight && targetAgentId ? { targetAgentId } : {}),
    ...(trimmed(data.reason) ? { reason: trimmed(data.reason) } : {}),
    ...(trimmed(data.nextAction) ? { nextAction: trimmed(data.nextAction) } : {}),
    ...(trimmed(data.evidence) ? { evidence: trimmed(data.evidence) } : {}),
    ...(trimmed(data.recommendedOptionId) ? { recommendedOptionId: trimmed(data.recommendedOptionId) } : {}),
    ...(trimmed(data.recommendationReason) ? { recommendationReason: trimmed(data.recommendationReason) } : {}),
  };
}

export async function authorizeOwnerRecoveryApi(db: Db, issueId: string, actor: OwnerRecoveryApiActor,
  data: MissionOwnerDecisionSubmit) {
  return authorizeOwnerRecoveryApiWithDependencies(db, issueId, actor, data, { toSubmission });
}

export async function submitMissionOwnerDecision(input: {
  readonly db: Db;
  readonly issueId: string;
  readonly actor: OwnerRecoveryApiActor;
  readonly data: MissionOwnerDecisionSubmit;
}): Promise<SubmittedMissionOwnerDecision> {
  const committed = await input.db.transaction(async (tx) => {
    // Acquire the human scope's full native lock prefix before the existing authorizer can
    // lock an issue/step. Pointer locks are deliberately deferred until checkout is authorized.
    const humanAuthority = await lockOwnerHumanSubmission(tx, input.issueId, input.actor, input.data);
    const auth = await authorizeOwnerRecoveryApi(tx as unknown as Db, input.issueId, input.actor, input.data);
    if (!auth) throw conflict("Owner-recovery decision API can only be used for mission-owner unblock issues");
    const { issue, sourceIssueId, sourceIssueOriginKind, isOversight } = auth;
    const submission = toSubmission(input.data, isOversight);
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
    if (needsHumanAlert && !humanAuthority) {
      throw conflict("Owner-recovery human submission scope changed; resubmit");
    }
    const human = needsHumanAlert
      ? await recordOwnerHumanSubmission(humanAuthority!, effectiveSubmission)
      : null;
    const recorded = human?.recorded ?? await recordMissionOwnerDecision({
      db: tx,
      issue: { id: issue.id, companyId: issue.companyId, missionId: issue.missionId! },
      submission: effectiveSubmission,
      sourceIssueId,
      heartbeatRunId: input.actor.runId,
    });
    return { recorded, human, issue, sourceIssueOriginKind, submission };
  });
  const { recorded, human, issue, sourceIssueOriginKind, submission } = committed;
  if (human?.humanInserted && human.humanPayload) {
    publishHumanOperatorRequestEvent(issue.companyId, human.humanPayload);
  }
  let operatorDecisionId: string | undefined;
  if (human) {
    try {
      const card = await createMissionOwnerHumanInputDecisionCard(input.db, human.humanInputCardSpec);
      operatorDecisionId = card.decision.id;
    } catch (error) {
      throw new HttpError(500, "Operator decision card creation failed after the decision was committed. Resubmit the same decision — the ledger dedup returns the same event and the card is recreated by its idempotent request key.", {
        code: "mission_owner_human_input_card_failed",
        decisionEventId: recorded.eventId,
        lifetimeId: human.lifetimeId,
        requestKey: human.humanInputCardSpec.lifetimeId
          ? `moi2:${human.lifetimeId}` : `moi1:${recorded.eventId}`,
        resubmit: { ...recorded.submission, humanRequest: human.humanRequest },
        cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
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
  return human ? { ...recorded, lifetimeId: human.lifetimeId,
    humanRequest: human.humanRequest, operatorDecisionId } : recorded;
}
