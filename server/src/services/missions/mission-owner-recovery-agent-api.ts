// server/src/services/missions/mission-owner-recovery-agent-api.ts
//
// [목적] mission-owner recovery 결정의 구조적 제출 API 핸들러. 자연어 comment 가 아닌
//   POST /issues/:id/owner-recovery/decision 만 결정을 workflow_transition_events 에 영속화한다.
// [권한] 체크아웃된 unblock 또는 제한된 oversight issue의 agent run 만 제출 가능.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { workflowRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { badRequest, conflict, HttpError } from "../../errors.js";
import { ownerDecisionRequestsHuman } from "./owner-tool-recovery-eligibility.js";
import { authorizeOwnerRecoveryApi as authorizeOwnerRecoveryApiWithDependencies } from "./owner-recovery-api-auth.js";
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
import {
  createMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec,
} from "./mission-owner-human-input-card.js";

export type OwnerRecoveryApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

function toSubmission(data: MissionOwnerDecisionSubmit, oversight = false): MissionOwnerDecisionSubmission {
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
    ...(!oversight && trimmed(data.sourceIssueRef) ? { sourceIssueRef: trimmed(data.sourceIssueRef) } : {}),
    ...(!oversight && trimmed(data.reworkTargetRef) ? { reworkTargetRef: trimmed(data.reworkTargetRef) } : {}),
    // Structured reassignment authority only — free-text nextAction/reason never supplies the assignee.
    ...(!oversight && targetAgentId ? { targetAgentId } : {}),
    ...(trimmed(data.reason) ? { reason: trimmed(data.reason) } : {}),
    ...(trimmed(data.nextAction) ? { nextAction: trimmed(data.nextAction) } : {}),
    ...(trimmed(data.evidence) ? { evidence: trimmed(data.evidence) } : {}),
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
}): Promise<RecordedMissionOwnerDecision> {
  // Authorization, checkout adoption and decision insertion must roll back together.
  const committed = await input.db.transaction(async (tx) => {
    const auth = await authorizeOwnerRecoveryApi(tx as unknown as Db, input.issueId, input.actor, input.data);
    if (!auth) throw conflict("Owner-recovery decision API can only be used for mission-owner unblock issues");
    const { issue, ownerAgentId, sourceIssueId, sourceIssueOriginKind, sourceIssueOriginRunId, isOversight } = auth;
    const submission = toSubmission(input.data, isOversight);
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
    let humanInputCardSpec: MissionOwnerHumanInputCardSpec | null = null;
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
      if (humanPayload) {
        // [D5] workflowRunId 는 실제 workflowRuns 행이 확인될 때만 스냅샷에 넣는다 — heartbeat
        //   runId 는 heartbeatRuns.id 라 별도 테이블이며, 엉칻은 값은 resolve 시 영구 409 가 된다.
        let verifiedRunId: string | null = null;
        if (sourceIssueOriginRunId) {
          const [runRow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns)
            .where(and(eq(workflowRuns.id, sourceIssueOriginRunId), eq(workflowRuns.companyId, issue.companyId)))
            .limit(1);
          verifiedRunId = runRow?.id ?? null;
        }
        // [D4 fail-closed] 매핑 근거(앵커) 해석 불가는 커밋 전 422 — ledger·알림이 함께 롤백되고
        //   오너가 증거를 갖춰 재제출하면 새 결정 이벤트로 다시 진행된다.
        humanInputCardSpec = {
          companyId: issue.companyId,
          missionId: humanPayload.missionId,
          decisionEventId: recorded.eventId,
          decision: humanPayload.decision,
          ownerActionIssueId: issue.id,
          ownerActionIssueStatus: auth.ownerIssueStatus ?? "",
          requestedByAgentId: ownerAgentId,
          reason: humanPayload.reason,
          nextAction: humanPayload.nextAction,
          evidence: humanPayload.evidence,
          issueTitle: humanPayload.issueTitle ?? null,
          issueIdentifier: humanPayload.issueIdentifier ?? null,
          sourceIssueId: humanPayload.sourceIssueId ?? null,
          workflowRunId: verifiedRunId,
        };
      }
    }
    return { recorded, humanInserted, humanPayload, humanInputCardSpec, issue, sourceIssueOriginKind, submission };
  });
  const { recorded, humanInserted, humanPayload, humanInputCardSpec, issue, sourceIssueOriginKind, submission } = committed;
  if (humanInserted && humanPayload) {
    publishHumanOperatorRequestEvent(issue.companyId, humanPayload);
  }
  // [D4] 카드 생성은 ledger 커밋 후 — write.create() 가 자체 트랜잭션을 소유하므로 외부 tx 에
  //   넣지 않는다. 실패 시 요청을 5xx 로 실패(fail-closed): 에이전트 재제출 → ledger dedup 이
  //   동일 eventId 반환 → requestKey 멱등으로 카드 재생성. 알림 1회 계약은 유지된다.
  if (humanInputCardSpec) {
    try {
      await createMissionOwnerHumanInputDecisionCard(input.db, humanInputCardSpec);
    } catch (error) {
      throw new HttpError(500, "Operator decision card creation failed after the decision was committed. Resubmit the same decision — the ledger dedup returns the same event and the card is recreated by its idempotent request key.", {
        code: "mission_owner_human_input_card_failed",
        decisionEventId: recorded.eventId,
        requestKey: humanInputCardSpec.decisionEventId ? `moi1:${humanInputCardSpec.decisionEventId}` : null,
        cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
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
