// server/src/services/quality/plan-qa-wake-admission.ts
//
// [파일 목적] T8 PLAN-QA 재제출 wake 키의 admission 수락 원문 작성. agent_wakeup_requests
//   admission/승격 트랜잭션 안에서만 호출된다(§3.3: 커밋 전 깨우기 금지 준수).
// [권위] 수락 원문은 검토 원장(mission_plan_qa_verdicts.qualityContract)의 예약 dispatch 원장에
//   같은 intentKey 이 존재할 때만 쓴다(§3.1). 원장이 없으면 수락 없이 null — 실패 닫힘.
//   inputHash/generation 은 서버 표식(issues.qualityPlanQaBinding)에서 읽어 날조하지 않는다.
import { and, desc, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missionPlanQaVerdicts, type Db } from "@paperclipai/db";
import { planQaVerdictStateSchema } from "@paperclipai/shared";
import { parsePlanQaResubmissionWakeKey } from "./native-wake.js";
import { planQaReviewBindingMarkerSchema } from "../missions/plan-qa-review-binding.js";

export type PlanQaWakeAcceptanceInput = {
  companyId: string;
  agentId: string;
  issueId: string | null;
  workflowRunId: string | null;
  idempotencyKey: string | null;
  runId: string;
  acceptedAt: Date;
};

/** [T8] deferred 승격 경로용 수락 원문. 재제출 키일 때만 권위 원장을 확인해 patch 를 만들고,
 *  다른 키 종류는 null(기존 deferred 동작 유지). 승격 tx 안에서만 호출한다. */
export async function planQaResubmissionPromotionAcceptancePatch(
  db: Pick<Db, "select">,
  input: {
    idempotencyKey: string | null; companyId: string; agentId: string; issueId: string;
    workflowRunId: string | null; runId: string; acceptedAt: Date;
  },
): Promise<Record<string, unknown> | null> {
  if (!parsePlanQaResubmissionWakeKey(input.idempotencyKey)) return null;
  return buildPlanQaResubmissionAcceptancePatch(db, input);
}

/** [T8 bounded resubmission] 재제출 승격 run 이 시작할 실제 새 execution epoch. 이 이슈의
 *  기존 run 중 최대 epoch + 1 (구조화된 DB 값만 근거). 재제출 키가 아니면 null — 이전 시도의
 *  epoch 를 재사용해 새 시도가 위장되지 않게 한다. */
export async function nextPlanQaResubmissionExecutionEpoch(
  db: Pick<Db, "select">,
  input: { idempotencyKey: string | null; companyId: string; issueId: string | null },
): Promise<number | null> {
  if (!parsePlanQaResubmissionWakeKey(input.idempotencyKey) || !input.issueId) return null;
  const [row] = await db.select({ epoch: heartbeatRuns.executionEpoch })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, input.issueId),
    ))
    .orderBy(desc(heartbeatRuns.executionEpoch))
    .limit(1);
  return (row?.epoch ?? -1) + 1;
}

/** PLAN-QA 재제출 키가 아니면 null(기존 quality-action-wake 경로와 무관). */
export async function buildPlanQaResubmissionAcceptancePatch(
  db: Pick<Db, "select">,
  input: PlanQaWakeAcceptanceInput,
): Promise<Record<string, unknown> | null> {
  const parsed = parsePlanQaResubmissionWakeKey(input.idempotencyKey);
  if (!parsed || !input.issueId || parsed.issueId !== input.issueId) return null;

  // [권위] 예약 원장에 같은 키의 dispatch 기록이 있어야만 수락 원문을 쓴다.
  const [row] = await db.select({ qualityContract: missionPlanQaVerdicts.qualityContract })
    .from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, input.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, parsed.issueId),
      eq(missionPlanQaVerdicts.decisionHash, parsed.decisionHash),
    ))
    .limit(1);
  const state = planQaVerdictStateSchema.safeParse(row?.qualityContract);
  const dispatch = state.success
    ? state.data.dispatches.find((record) => record.intentKey === input.idempotencyKey)
    : undefined;
  if (!dispatch) return null;

  const [issue] = await db.select({ marker: issues.qualityPlanQaBinding })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, parsed.issueId)))
    .limit(1);
  const marker = planQaReviewBindingMarkerSchema.safeParse(issue?.marker ?? null);
  if (!marker.success || marker.data.decisionHash !== parsed.decisionHash
    || marker.data.reviewGeneration !== parsed.generation) return null;

  return {
    qualityAcceptance: {
      intentKey: input.idempotencyKey,
      inputHash: marker.data.inputHash,
      issueId: parsed.issueId,
      stepRunId: null,
      workflowRunId: input.workflowRunId,
      generation: marker.data.reviewGeneration,
      agentId: input.agentId,
      attempt: dispatch.attempt,
      acceptedAt: input.acceptedAt.toISOString(),
      heartbeatRunId: input.runId,
    },
  };
}
