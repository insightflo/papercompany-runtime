// server/src/services/missions/plan-qa-resubmission.ts
//
// [파일 목적] T8 bounded resubmission 원장. 소명 누락 결과를 버전 있는 계약으로 검토 원장에
//   영속 저장(예약 전에 정확한 MissingEvidence + 현재 scope 고정 값)하고, 커밋 뒤 기존
//   heartbeat wakeup 권위로 유한 횟수 안에서만 재제출 실행을 요청한다.
// [경계] 이 파일은 타이머·큐를 만들지 않고, 콜백 반환값·행 존재만으로 수락을 만들지 않는다.
//   수락 증거는 오직 admission 트랜잭션이 기록한 agent_wakeup_requests.qualityAcceptance 원문이다.
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, issues, missionPlanQaVerdicts, type Db } from "@paperclipai/db";
import {
  missingEvidenceSchema, planQaResubmissionDispatchSchema, planQaVerdictStateSchema,
  type MissingEvidence, type PlanQaResubmissionDispatch, type PlanQaScope, type PlanQaVerdictState,
} from "@paperclipai/shared";
import { hashContract, parseEvidence } from "../quality/contract.js";
import { planQaResubmissionWakeKey } from "../quality/native-wake.js";
import { logActivity } from "../activity-log.js";

export type PinnedPlanQaPolicy = { policyVersionId: string; definitionSha256: string } | null;

export type PlanQaResubmissionWakeDispatcher = (input: {
  companyId: string;
  agentId: string;
  issueId: string;
  missionId: string;
  intentKey: string;
  attempt: number;
}) => Promise<unknown> | unknown;

/** [불변 규칙] 고정 정책이 없거나 소진되었으면 예약하지 않는다. 같은 검토 시도(scope)에는
 * 정확히 한 건만 예약한다. attempt 는 누적 원장 길이 + 1 (scope 변경과 무관하게 누적). */
export function planResubmissionDispatchDecision(input: {
  state: PlanQaVerdictState;
  scope: PlanQaScope;
  max: number;
  policy: PinnedPlanQaPolicy;
  missing: MissingEvidence;
}): PlanQaResubmissionDispatch | null {
  const dispatches = input.state.dispatches ?? [];
  if (input.max <= 0 || dispatches.length >= input.max) return null;
  if (dispatches.some((record) => hashContract(record.missingEvidence.scope) === hashContract(input.scope))) return null;
  const attempt = dispatches.length + 1;
  return parseEvidence(planQaResubmissionDispatchSchema, {
    schemaVersion: 1,
    kind: "plan_qa_resubmission_dispatch",
    attempt,
    intentKey: planQaResubmissionWakeKey({
      issueId: input.scope.issueId,
      decisionHash: input.scope.decisionHash,
      generation: input.scope.reviewGeneration,
      attempt,
    }),
    missingEvidence: parseEvidence(missingEvidenceSchema, input.missing),
    policyVersionId: input.policy?.policyVersionId ?? null,
    policyDefinitionSha256: input.policy?.definitionSha256 ?? null,
    maxResubmissions: input.max,
    dispatchedAt: new Date().toISOString(),
    requestedAt: null,
  });
}

export function appendResubmissionDispatch(state: PlanQaVerdictState, record: PlanQaResubmissionDispatch): PlanQaVerdictState {
  return { ...state, dispatches: [...(state.dispatches ?? []), record] };
}

export type PlanQaResubmissionDispatchOutcome = { requested: boolean; accepted: boolean };

/** [커밋 뒤 실행] 저장된 최신 예약 원장을 검사해 아직 wake 요청이 없으면 기존 실행 권위로
 * 요청한다. requested 는 요청 여부일 뿐이고 accepted 는 저장된 수락 원문으로만 판정한다. */
export async function dispatchPendingPlanQaResubmission(db: Db, input: {
  companyId: string;
  planQaIssueId: string;
  decisionHash: string;
  missionId: string;
  enqueue?: PlanQaResubmissionWakeDispatcher | null;
}): Promise<PlanQaResubmissionDispatchOutcome> {
  const [row] = await db.select({ qualityContract: missionPlanQaVerdicts.qualityContract })
    .from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, input.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
      eq(missionPlanQaVerdicts.decisionHash, input.decisionHash),
    ))
    .limit(1);
  const state = planQaVerdictStateSchema.safeParse(row?.qualityContract);
  const records: PlanQaResubmissionDispatch[] = state.success ? [...state.data.dispatches] : [];
  const record = records[records.length - 1];
  if (!record) return { requested: false, accepted: false };

  const [existing] = await db.select({ qualityAcceptance: agentWakeupRequests.qualityAcceptance })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, record.intentKey),
    ))
    .limit(1);
  if (existing) {
    return { requested: true, accepted: Boolean(existing.qualityAcceptance
      && typeof existing.qualityAcceptance === "object") };
  }
  if (!input.enqueue) return { requested: false, accepted: false };
  if (record.requestedAt) return { requested: true, accepted: false };

  const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId, missionId: issues.missionId })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.planQaIssueId)))
    .limit(1);
  const agentId = issue?.assigneeAgentId;
  if (!agentId) return { requested: false, accepted: false };

  await input.enqueue({
    companyId: input.companyId,
    agentId,
    issueId: input.planQaIssueId,
    missionId: issue?.missionId ?? input.missionId,
    intentKey: record.intentKey,
    attempt: record.attempt,
  });
  // 요청 표식을 원장에 영속 기록한다(콜백 결과와 무관). 두 번 요청해도 admission 의 정확한
  // 키 dedupe 가 하나의 행만 만들므로 중복 wake 는 생기지 않는다.
  records[records.length - 1] = { ...record, requestedAt: new Date().toISOString() };
  const [current] = await db.select({ id: missionPlanQaVerdicts.id, qualityContract: missionPlanQaVerdicts.qualityContract })
    .from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, input.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
      eq(missionPlanQaVerdicts.decisionHash, input.decisionHash),
    ))
    .limit(1);
  const currentState = planQaVerdictStateSchema.safeParse(current?.qualityContract);
  if (current && currentState.success) {
    const merged: PlanQaVerdictState = {
      ...currentState.data,
      dispatches: currentState.data.dispatches.map((entry) => entry.intentKey === record.intentKey
        ? { ...entry, requestedAt: records[records.length - 1]!.requestedAt }
        : entry),
    };
    await db.update(missionPlanQaVerdicts).set({ qualityContract: merged, updatedAt: new Date() })
      .where(eq(missionPlanQaVerdicts.id, current.id));
  }
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "mission-plan-qa",
    action: "mission.plan_qa.resubmission_wake_requested",
    entityType: "issue",
    entityId: input.planQaIssueId,
    details: { intentKey: record.intentKey, attempt: record.attempt, decisionHash: input.decisionHash },
  });
  return { requested: true, accepted: false };
}
