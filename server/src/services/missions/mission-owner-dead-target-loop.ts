// server/src/services/missions/mission-owner-dead-target-loop.ts
//
// [목적] "죽은 대상(dead target) 향한 owner retry 무한 no-op 순환" 방지 유틸. 2026-10-18 라이브
//   사고(mission ff703920, 17h+ 교착)에서 종결(done) 소스를 가리키는 retry_source_issue — owner 결정과
//   grace auto-default 모두 — 가 매 감시 틱마다 not_applied 로 거부되고, tool recovery 카드의
//   no_op(target_missing) 대기도 같이 순환했다. 이 모듈은 그 순환을 구조화 마커로 세어 차단하고
//   사람 결정 카드로 1회 에스컬레이션한다.
//   구성: (1) not_applied 마커 기록/집계(workflowTransitionEvents, 자연어 파싱 금지 원칙 준수),
//         (2) 죽은 대상 조합별 claim-once 에스컬레이션 이벤트 + system 발신 사람 결정 카드 보증.
// [외부 연결] caller: services/missions/supervision.ts(grace default 선택기, retry 적용 단계,
//   tool recovery no_op 처리). 카드 생성: mission-owner-human-input-card.ts(moi1:{eventId} 멱등).
// [수정시 주의] 마커/claim 키는 (company, owner-action, 결정종류, 대상) 조합으로만 구성 — 특정
//   이슈 하드코딩 금지. 살아있는 대상 재시도·owner 수동 결정 자유·감시 주기는 이 모듈이 바꾸지 않는다.
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  operatorDecisions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { createMissionOwnerHumanInputDecisionCard } from "./mission-owner-human-input-card.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION,
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
} from "./workflow-restart-option.js";

export const OWNER_DECISION_NOT_APPLIED_EVENT = "mission_owner_decision_not_applied";
export const OWNER_DEAD_TARGET_ESCALATION_EVENT = "mission_owner_dead_target_escalation";
export const OWNER_DEAD_TARGET_ESCALATION_LAYER = "mission_owner_recovery";
/** 같은 (owner-action, 결정종류, 대상) 조합이 이 횟수만큼 거부되면 재적용을 억제하고 사람 에스컬레이션으로 전환한다. */
export const DEAD_TARGET_RETRY_BREAKER_THRESHOLD = 3;

export type OwnerDecisionNotAppliedReasonCode =
  | "source_unresolvable"
  | "source_missing"
  | "source_other_mission"
  | "source_hidden"
  | "source_terminal"
  | "tool_target_missing";

function notAppliedCorrelationId(ownerActionIssueId: string, decision: string, sourceIssueId: string, decisionEventId: string): string {
  return `not-applied:${ownerActionIssueId}:${decision}:${sourceIssueId}:${decisionEventId}`;
}

/** 같은 조합의 구조적 거부(not_applied)를 1틱 1마커로 영속화한다. 자연어 코멘트는 근거로 쓰지 않는다. */
export async function recordOwnerDecisionNotApplied(db: Db, input: {
  readonly companyId: string;
  readonly missionId: string;
  readonly ownerActionIssueId: string;
  readonly decision: string;
  readonly sourceIssueId: string;
  /** 결정 이벤트 식별자. owner 재결정(새 eventId)은 카운트를 초기화해 수동 결정 자유를 보존한다. grace default 등 무기록 결정은 "auto". */
  readonly decisionEventId: string;
  readonly reason: string;
  readonly reasonCode: OwnerDecisionNotAppliedReasonCode;
  readonly occurredAt: Date;
}): Promise<void> {
  await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.ownerActionIssueId,
    eventType: OWNER_DECISION_NOT_APPLIED_EVENT,
    layer: OWNER_DEAD_TARGET_ESCALATION_LAYER,
    toStatus: "not_applied",
    decision: input.decision,
    reason: input.reason.slice(0, 1_000),
    reasonCode: input.reasonCode,
    correlationId: notAppliedCorrelationId(input.ownerActionIssueId, input.decision, input.sourceIssueId, input.decisionEventId),
    idempotencyKey: [
      OWNER_DECISION_NOT_APPLIED_EVENT,
      input.ownerActionIssueId,
      input.decision,
      input.sourceIssueId,
      input.decisionEventId,
      input.occurredAt.toISOString(),
    ].join(":"),
    payload: {
      kind: OWNER_DECISION_NOT_APPLIED_EVENT,
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decisionEventId: input.decisionEventId,
      reasonCode: input.reasonCode,
    },
  }).onConflictDoNothing();
}

/** 같은 조합의 누적 not_applied 횟수. 회로 차단기 판정 근거. */
export async function countOwnerDecisionNotApplied(db: Db, input: {
  readonly companyId: string;
  readonly ownerActionIssueId: string;
  readonly decision: string;
  readonly sourceIssueId: string;
  readonly decisionEventId: string;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.eventType, OWNER_DECISION_NOT_APPLIED_EVENT),
      eq(workflowTransitionEvents.correlationId, notAppliedCorrelationId(
        input.ownerActionIssueId,
        input.decision,
        input.sourceIssueId,
        input.decisionEventId,
      )),
    ));
  return row?.count ?? 0;
}

// 표시용 다음 행동. 실행 선택지는 아래의 구조화 binding 조회 결과에서만 만든다.
const DEAD_TARGET_NEXT_ACTION_EN = "Select a recovery path for the unusable retry target (replan the mission, retry a different live source, record an explicit recovery target, or cancel this recovery)";

async function resolveDeadTargetCardBinding(db: Db, input: {
  companyId: string; missionId: string; sourceIssueId: string | null;
}) {
  const missing = {
    workflowRunId: null,
    structuredOptions: [{ id: "missing-recovery-target", label: "복구 대상 지정 필요",
      description: "종결된 원천을 다시 실행하지 않습니다. 새 구조화 복구 대상을 지정해야 합니다." }],
    recommendedOptionId: "missing-recovery-target",
    recommendationReason: "현재 선택에는 실행 가능한 구조화 대상이 없습니다.",
  };
  if (!input.sourceIssueId) return missing;
  const [source] = await db.select({ id: workflowRuns.id, workflowId: workflowRuns.workflowId })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      eq(workflowStepRuns.issueId, input.sourceIssueId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
      eq(workflowRuns.status, "failed"),
      isNull(workflowRuns.parentRunId),
    ))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(1);
  if (!source) return missing;
  const [activeReplacement] = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
      eq(workflowRuns.workflowId, source.workflowId),
      isNull(workflowRuns.parentRunId),
      ne(workflowRuns.id, source.id),
      or(
        inArray(workflowRuns.status, ["pending", "running"]),
        sql`${workflowRuns.metadata}->'operatorDecisionRestart'->>'sourceWorkflowRunId' = ${source.id}`,
      ),
    ))
    .limit(1);
  if (activeReplacement) return missing;
  return {
    workflowRunId: source.id,
    structuredOptions: [{ id: WORKFLOW_RESTART_FROM_START_OPTION_ID,
      label: WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
      description: WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION }],
    recommendedOptionId: WORKFLOW_RESTART_FROM_START_OPTION_ID,
    recommendationReason: "종결된 원천을 다시 열지 않고 같은 미션의 새 최상위 실행을 시작합니다.",
  };
}

/**
 * [죽은 대상 에스컬레이션 카드 1회 보증] 조합별 claim-once 이벤트(mission_owner_dead_target_escalation)를
 *   쌓고 그 eventId 로 system 발신 사람 결정 카드(moi1:{eventId})를 만든다. 이미 claim 됐으면 기존
 *   eventId 로 카드만 재보증(requestKey 멱등 replay). 앵커 이슈가 모두 종결이면 카드를 만들지 않는다
 *   (#390 terminal-anchor sweep 정책 — 종결 앵커 카드는 즉시 스윕되므로).
 */
export async function ensureDeadTargetHumanEscalation(db: Db, input: {
  readonly companyId: string;
  readonly missionId: string;
  readonly ownerAgentId: string | null;
  /** 순환 식별자 — 예: "retry_source_issue", "tool_recovery_target_missing". 같은 순환은 1회만 카드를 만든다. */
  readonly loopKey: string;
  /** 카드 앵커 후보(앞에서부터 첫 비종결 이슈 사용). owner-action 종결(자동 정리) 시 oversight 로 대체된다. */
  readonly anchors: ReadonlyArray<{ id: string; status: string; title: string | null; identifier: string | null }>;
  readonly ownerActionIssueId: string;
  readonly sourceIssueId: string | null;
  readonly reason: string;
  readonly evidence: string;
}): Promise<{ ensured: boolean; reason: string }> {
  const anchor = input.anchors.find((candidate) => candidate.status !== "done" && candidate.status !== "cancelled") ?? null;
  if (!anchor) return { ensured: false, reason: "no-open-anchor-issue" };
  if (!input.ownerAgentId) return { ensured: false, reason: "owner-agent-missing" };
  const claimKey = [
    OWNER_DEAD_TARGET_ESCALATION_EVENT,
    input.ownerActionIssueId,
    input.loopKey,
    input.sourceIssueId ?? "none",
  ].join(":");
  let claimed = await db
    .insert(workflowTransitionEvents)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      issueId: input.ownerActionIssueId,
      eventType: OWNER_DEAD_TARGET_ESCALATION_EVENT,
      layer: OWNER_DEAD_TARGET_ESCALATION_LAYER,
      toStatus: "escalated",
      decision: "escalate",
      reason: input.reason.slice(0, 1_000),
      reasonCode: OWNER_DEAD_TARGET_ESCALATION_EVENT,
      correlationId: input.ownerActionIssueId,
      idempotencyKey: claimKey,
      payload: {
        kind: OWNER_DEAD_TARGET_ESCALATION_EVENT,
        ownerActionIssueId: input.ownerActionIssueId,
        anchorIssueId: anchor.id,
        sourceIssueId: input.sourceIssueId,
        loopKey: input.loopKey,
      },
    })
    .onConflictDoNothing()
    .returning({ id: workflowTransitionEvents.id });
  if (claimed.length === 0) {
    // 이미 같은 순환을 에스컬레이션 했다 — 같은 requestKey 카드가 이미 있으면 재생성하지 않는다
    //   (create replay 는 requestHash 까지 동일해야 하므로, 틱마다 달라지는 진단 텍스트로 충돌하지 않게
    //   카드 존재만 확인한다). 카드가 없으면(브리지 없던 배포 등) 기존 eventId 로 다시 만든다.
    const [existing] = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.companyId, input.companyId),
        eq(workflowTransitionEvents.idempotencyKey, claimKey),
      ))
      .limit(1);
    if (!existing) return { ensured: false, reason: "claim-race" };
    const requestKey = `moi1:${existing.id}`;
    const [existingCard] = await db
      .select({ id: operatorDecisions.id })
      .from(operatorDecisions)
      .where(and(
        eq(operatorDecisions.companyId, input.companyId),
        eq(operatorDecisions.requestKey, requestKey),
      ))
      .limit(1);
    if (existingCard) return { ensured: true, reason: "card-exists" };
    claimed = [{ id: existing.id }];
  }
  try {
    const binding = await resolveDeadTargetCardBinding(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      sourceIssueId: input.sourceIssueId,
    });
    await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      decisionEventId: claimed[0]!.id,
      decision: "escalate",
      ownerActionIssueId: anchor.id,
      ownerActionIssueStatus: anchor.status,
      requestedByAgentId: input.ownerAgentId,
      actorType: "system",
      reason: input.reason.slice(0, 2_000),
      nextAction: DEAD_TARGET_NEXT_ACTION_EN,
      evidence: input.evidence.slice(0, 2_000),
      issueTitle: anchor.title,
      issueIdentifier: anchor.identifier,
      sourceIssueId: input.sourceIssueId,
      workflowRunId: binding.workflowRunId,
      structuredOptions: binding.structuredOptions,
      recommendedOptionId: binding.recommendedOptionId,
      recommendationReason: binding.recommendationReason,
    });
    return { ensured: true, reason: "card-created" };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ensured: false, reason: `card-create-failed: ${message.slice(0, 200)}` };
  }
}
