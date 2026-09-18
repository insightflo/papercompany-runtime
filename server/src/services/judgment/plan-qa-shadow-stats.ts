// server/src/services/judgment/plan-qa-shadow-stats.ts
//
// [파일 목적] 트랙 B-2 — PLAN-QA 섀도 관측 비교 통계. mission_plan_qa_verdicts(정답측)와
//   judgment_calls(섀도 판단측)를 verdict correlationKey 로 조인해 파일럿 지표 3종을 계산한다.
//   조회 전용 함수 export 만 제공 — 라우트 노출 금지(운영 보고/분석용).
//
// [지표 정의] judged = 관측 창 내 verdict 중 outcome='observed' 감사행이 있는 것(여러 개면 최신).
//   - 생략 후보율(skipCandidateRate): judged 중 판단 overall='low_risk' 비율.
//     "전체 QA 를 생략했어도 됐을 비율" 후보 산정.
//   - 후보 구간 위험 불일치율(candidateMismatchRate): low_risk 로 분류한 것 중 정답측 verdict 가
//     수정요구 계열(revision family: 'request_changes' | 'missing_evidence')인 비율.
//     "생략 후보로 잡았는데 실제로는 수정이 필요했던 비율" — 오탐(False Positive) 위험.
//   - 놓침률(missRate): 수정요구 계열 verdict 중 low_risk 로 분류한 비율.
//     "수정이 필요했는데 놓쳤을 비율" — 누락(False Negative) 위험.
//   'pending' 은 미확정 판정이므로 양쪽 분모/분자에서 모두 제외한다.
//
// [verdict 값 도메인] mission_plan_qa_verdicts.verdict(text)의 실제 생성 값:
//   'pass' | 'request_changes' (recordMissionPlanQaVerdict/ValidationVerdict) 및
//   'pending' | 'missing_evidence' | 'pass' | 'request_changes' (addendum gate combinePlanQa).
//   수정요구 계열 = request_changes + missing_evidence.

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { judgmentCalls, missionPlanQaVerdicts } from "@paperclipai/db";
import type { JudgmentAnswer } from "@paperclipai/shared";

/** verdict 정답측 값 중 수정요구 계열(오탐/누락 위험 판정 기준). */
export const PLAN_QA_REVISION_FAMILY_VERDICTS = new Set(["request_changes", "missing_evidence"]);

export interface PlanQaShadowStatsInput {
  companyId?: string;
  /** 관측 창(일). 기본 7. */
  days?: number;
  now?: Date;
}

export interface PlanQaShadowStats {
  windowDays: number;
  companyId: string | null;
  /** 관측 창 내 verdict 수. */
  totalVerdicts: number;
  /** observed 감사행이 있는 verdict 수(평가 완료). */
  judged: number;
  /** 판단 overall='low_risk' 수. */
  skipCandidates: number;
  /** 생략 후보율 = skipCandidates / judged (judged 0 이면 null). */
  skipCandidateRate: number | null;
  /** low_risk ∧ 수정요구 계열 verdict 수(불일치·놓침 공통 분자). */
  candidateMismatches: number;
  /** 후보 구간 위험 불일치율 = candidateMismatches / skipCandidates (후보 0 이면 null). */
  candidateMismatchRate: number | null;
  /** 수정요구 계열 verdict 중 관측된 수(놓침률 분모). */
  revisionFamilyJudged: number;
  /** 놓침률 = candidateMismatches / revisionFamilyJudged (분모 0 이면 null). */
  missRate: number | null;
}

function readOverallAnswer(answers: JudgmentAnswer[] | null): { value: string | null; confidence: number | null } {
  if (!answers) return { value: null, confidence: null };
  const overall = answers.find((answer) => answer.name === "overall");
  if (!overall || typeof overall.value !== "string") return { value: null, confidence: null };
  return { value: overall.value, confidence: overall.confidence ?? null };
}

/**
 * [목적] computePlanQaShadowStats — 섀도 관측 파일럿 지표 3종 + 총 평가 수 계산.
 *   verdict(정답측)와 최신 observed 판단(섀도측)을 조인한다. 라우트 노출 금지.
 * [출력] PlanQaShadowStats. 비율은 0~1.
 */
export async function computePlanQaShadowStats(
  db: Db,
  input: PlanQaShadowStatsInput = {},
): Promise<PlanQaShadowStats> {
  const now = input.now ?? new Date();
  const days = input.days ?? 7;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const verdictWhere = input.companyId
    ? and(
        eq(missionPlanQaVerdicts.companyId, input.companyId),
        gte(missionPlanQaVerdicts.createdAt, cutoff),
      )
    : gte(missionPlanQaVerdicts.createdAt, cutoff);
  const verdicts = await db
    .select({
      id: missionPlanQaVerdicts.id,
      verdict: missionPlanQaVerdicts.verdict,
    })
    .from(missionPlanQaVerdicts)
    .where(verdictWhere);

  if (verdicts.length === 0) {
    return {
      windowDays: days,
      companyId: input.companyId ?? null,
      totalVerdicts: 0,
      judged: 0,
      skipCandidates: 0,
      skipCandidateRate: null,
      candidateMismatches: 0,
      candidateMismatchRate: null,
      revisionFamilyJudged: 0,
      missRate: null,
    };
  }

  const calls = await db
    .select({
      correlationKey: judgmentCalls.correlationKey,
      answers: judgmentCalls.answers,
      createdAt: judgmentCalls.createdAt,
    })
    .from(judgmentCalls)
    .where(
      and(
        eq(judgmentCalls.contextType, "mission_plan_qa"),
        eq(judgmentCalls.outcome, "observed"),
        inArray(
          judgmentCalls.correlationKey,
          verdicts.map((verdict) => `mission_plan_qa:${verdict.id}`),
        ),
      ),
    )
    .orderBy(desc(judgmentCalls.createdAt));

  // verdict 별 최신 observed 판단 1건만 사용(재관측 시 최신 우선).
  const latestByVerdict = new Map<string, { value: string | null; confidence: number | null }>();
  for (const call of calls) {
    const key = call.correlationKey;
    if (key === null || latestByVerdict.has(key)) continue;
    latestByVerdict.set(key, readOverallAnswer(call.answers));
  }

  let judged = 0;
  let skipCandidates = 0;
  let candidateMismatches = 0;
  let revisionFamilyJudged = 0;
  for (const verdict of verdicts) {
    const judgment = latestByVerdict.get(`mission_plan_qa:${verdict.id}`);
    if (!judgment) continue;
    judged += 1;
    const isLowRisk = judgment.value === "low_risk";
    const isRevisionFamily = PLAN_QA_REVISION_FAMILY_VERDICTS.has(verdict.verdict);
    if (isLowRisk) skipCandidates += 1;
    if (isRevisionFamily) revisionFamilyJudged += 1;
    if (isLowRisk && isRevisionFamily) candidateMismatches += 1;
  }

  return {
    windowDays: days,
    companyId: input.companyId ?? null,
    totalVerdicts: verdicts.length,
    judged,
    skipCandidates,
    skipCandidateRate: judged === 0 ? null : skipCandidates / judged,
    candidateMismatches,
    candidateMismatchRate: skipCandidates === 0 ? null : candidateMismatches / skipCandidates,
    revisionFamilyJudged,
    missRate: revisionFamilyJudged === 0 ? null : candidateMismatches / revisionFamilyJudged,
  };
}
