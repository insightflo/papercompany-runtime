// Structured owner-recovery submission. Authorization/checkout and all durable request facts
// commit together. Card creation retains its existing post-commit recovery boundary.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { badRequest, conflict, HttpError, unprocessable } from "../../errors.js";
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
import { createMissionOwnerHumanInputDecisionCard, findPendingMissionHumanCard,
  bumpPendingMissionHumanCard } from "./mission-owner-human-input-card.js";
import { admitHumanCardForSource } from "./human-card-admission.js";
import { isExactOwnerHumanReplay } from "./owner-human-request-submit.js";
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
    // [R1 2026-11-08] Auto-recoverable causes never justify a human decision card. If the
    // source's latest terminal run failed with a retryable/settlement-owned error code
    // (429·quota adapter_failed, stale_queued, issue_status_blocked) or is still unsettled,
    // the escalation is rejected — retry/auto-recovery owns it, not a human card.
    if (needsHumanAlert && sourceIssueId) {
      const admission = await admitHumanCardForSource(tx, issue.companyId, sourceIssueId);
      if (!admission.admit) {
        throw unprocessable(
          "이 원천의 마지막 실패는 자동 복구 가능 원인입니다 — 사람 결정 카드를 발행하지 않습니다. 재시도·자동 회복 후에도 해결되지 않으면 새 근거와 함께 다시 제출하세요.",
          {
            code: "mission_owner_human_input_auto_recoverable",
            cause: admission.cause,
            runId: admission.runId,
            errorCode: admission.errorCode,
            sourceIssueId,
            decision: effectiveSubmission.decision,
          },
        );
      }
    }
    // [R2 2026-11-08] 미션당 열린 사람 카드 1장: 이 미션에 pending 사람 결정 카드가 있으면
    // 새 사람 요청(lifetime 교체)을 거부하고 기존 카드에 반복 사실만 누적한다(안정 키 =
    // missionId+원인분류). 카드 생성/갱신 계약(C08)은 그대로 두고 제출 경로에서만 차단한다.
    // 동일 요청의 재전송(replay)은 기존 카드의 멱등 재생성이므로 통과시키고, legacy(무효)
    // 제출은 기존 identityRequired 계약을 그대로 따른다(moi1 중복 병합 계약이 이미 존재).
    if (needsHumanAlert && humanAuthority && effectiveSubmission.humanRequest) {
      const pendingCard = await findPendingMissionHumanCard(tx, issue.companyId, humanAuthority.scope.missionId);
      if (pendingCard && !(await isExactOwnerHumanReplay(humanAuthority, effectiveSubmission))) {
        await bumpPendingMissionHumanCard(input.db, issue.companyId, humanAuthority.scope.missionId)
          .catch(() => undefined); // 진단 메타데이터 — 거부 처리에는 영향 없음
        throw unprocessable(
          "이 미션에는 답변 대기 중인 사람 결정 카드가 있습니다. 새 카드 대신 기존 카드가 처리될 때까지 기다려 주세요.",
          {
            code: "mission_owner_human_input_card_pending",
            pendingOperatorDecisionId: pendingCard.id,
            pendingRequestKey: pendingCard.requestKey,
            missionId: humanAuthority.scope.missionId,
            decision: effectiveSubmission.decision,
          },
        );
      }
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
