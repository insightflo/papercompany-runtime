// server/src/services/judgment/agent-judgment-shadow-stats.ts
//
// [파일 목적] Jev agent-judgment 섀도 캘리브레이션 — 조회 전용 비교 통계.
//   v2 섀도 판단(계산형 verdict)·v1 생산 판단(overall choice)·검증기 스텝(정답측)을
//   같은 contextId/runId 기준으로 조인해 캘리브레이션 지표를 계산한다.
//   라우트 노출 금지 — plan-qa-shadow-stats 선례(리포트/운영 조회 전용 함수).
//
// [정답측 정의] 정답측 = 같은 run 의 검증기 스텝(workflowStepRuns, 실제 도메인 completed/failed/skipped/pending/running).
//   검증기 미종결/행 없음/skipped → unknown; 검증기 failed → failed;
//   검증기 completed ∧ qa 종결 실패 → failed; 검증기 completed ∧ qa 없거나 completed → success.

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { judgmentCalls, judgmentDefinitions, workflowStepRuns } from "@paperclipai/db";
import { AGENT_JUDGMENT_DEFINITION_NAME } from "./agent-judgment-tool.js";
import { AGENT_JUDGMENT_SHADOW_DEFINITION_NAME } from "./agent-judgment-shadow.js";
import { AGENT_SHADOW_CONF_FLOOR_DEFAULT, computeAgentJudgmentShadowVerdict } from "./agent-judgment-shadow-state.js";

/** 정답측 validator 스텝 식별자(HTML 검증기). */
export const JEV_VALIDATOR_STEP_ID = "validate-tech-scout-html-report";
/** 정답측 QA 스텝 식별자(후속 품질 검사). */
export const JEV_QA_STEP_ID = "qa-tech-scout-html";

/** 정답측(같은 run 의 검증기 스텝) 판정. */
export type AgentShadowGroundTruth = "success" | "failed" | "unknown";

export interface AgentShadowStatsInput {
  companyId?: string;
  /** 관측 창(일). 기본 7. */
  days?: number;
  now?: Date;
  /** 정답측 validator 스텝 식별자 오버라이드(기본 JEV_VALIDATOR_STEP_ID). */
  validatorStepId?: string;
  /** 정답측 QA 스텝 식별자 오버라이드(기본 JEV_QA_STEP_ID). */
  qaStepId?: string;
  /** v2 verdict 계산용 신뢰도 바닥값 오버라이드. */
  confFloor?: number;
}

export interface AgentShadowStats {
  windowDays: number;
  companyId: string | null;
  /** 창 내 v1 대상 행의 contextId 그룹 수. */
  totalPrescreens: number;
  /** 섀도 행이 있는 contextId 수. */
  shadowed: number;
  /** shadow 행 중 observed + verdict 계산 가능한 수. */
  judged: number;
  /** judged 중 정답측 상태별 수. */
  validatorConfirmed: number;
  validatorFailed: number;
  validatorUnknown: number;
  /** judged 중 v2 low_risk 수(검토 생략 후보). */
  skipCandidates: number;
  /** skipCandidates / judged (judged 0 → null). */
  skipCandidateRate: number | null;
  /** low_risk ∧ groundTruth "failed" 수(오탐 위험). */
  candidateMismatches: number;
  /** candidateMismatches / skipCandidates (후보 0 → null). */
  candidateMismatchRate: number | null;
  /** groundTruth "failed" 인 judged 수(놓침률 분모). */
  revisionFamilyJudged: number;
  /** candidateMismatches / revisionFamilyJudged (분모 0 → null). */
  missRate: number | null;
  /** judged 중 최신 v1 행 overall choice 가 low_risk 인 수(v1 비교 기준은 judged 로 동일). */
  v1LowRisk: number;
  /** v1 low_risk ∧ groundTruth "failed" 수. */
  v1LowRiskMismatches: number;
  /** judged 중 v2 등급과 v1 overall 등급 일치 비율(judged 0 → null). */
  v2v1AgreementRate: number | null;
}

/**
 * [목적] workflow_step_runs.status 값 정규화 — 실제 DB 체크 제약 도메인은
 *   'pending'|'running'|'completed'|'failed'|'skipped' 다. completed 만 성공,
 *   failed 만 실패이고 나머지(미종결·skipped·미지정 값)는 unknown 이다.
 *   (skipped 검증기는 검증이 일어나지 않은 것이므로 정답 근거가 없다.)
 */
export function normalizeStepRunStatus(status: string | null): "success" | "failed" | "unknown" {
  if (status === "completed") return "success";
  if (status === "failed") return "failed";
  return "unknown";
}

/**
 * [목적] 정답측 계산(순수 함수) — runId 당 검증기/QA 스텝 상태에서 ground truth 를 낸다.
 *   입력은 workflow_step_runs.status 원문(DB 도메인: completed/failed/skipped/pending/running/null).
 *   검증기 종결 아님(completed 아님) → unknown(실패로 못 박지 않는 실패 닫힘);
 *   검증기 failed → failed; 검증기 completed ∧ qa 종결 실패(completed 아님) → failed;
 *   검증기 completed ∧ qa 없거나 completed → success.
 */
export function computeAgentShadowGroundTruth(
  validatorStatus: string | null,
  qaStatus: string | null,
): AgentShadowGroundTruth {
  const validator = normalizeStepRunStatus(validatorStatus);
  if (validator === "unknown") return "unknown";
  if (validator === "failed") return "failed";
  const qa = qaStatus === null ? "success" : normalizeStepRunStatus(qaStatus);
  if (qa === "failed") return "failed";
  if (qa === "unknown") return "unknown";
  return "success";
}

/** contextId("wfr:<runId>:step:<...>")에서 runId 를 파싱한다. 실패 시 null. */
function parseRunId(contextId: string): string | null {
  const match = /^wfr:([^:]+):step:/.exec(contextId);
  return match === null ? null : match[1];
}

/** 최신 v1 행 answers 에서 name "overall" choice 값을 꺼낸다(외부 JSON 직접 검증). */
function readOverallChoice(answers: unknown): string | null {
  if (!Array.isArray(answers)) return null;
  for (const entry of answers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const answer = entry as Record<string, unknown>;
    if (answer.name === "overall" && answer.type === "choice" && typeof answer.value === "string") {
      return answer.value;
    }
  }
  return null;
}

/** contextId별 최신 감사행 1건(createdAt asc 순회 → 덮어쓰기 = 최신 승리). */
interface LatestCallRow {
  answers: unknown;
  outcome: string;
}

async function latestCallsByContext(
  db: Db,
  input: { companyId?: string; cutoff: Date; definitionName: string; observedOnly: boolean },
): Promise<Map<string, LatestCallRow>> {
  const conditions = [
    eq(judgmentDefinitions.name, input.definitionName),
    eq(judgmentCalls.contextType, "workflow_step"),
    gte(judgmentCalls.createdAt, input.cutoff),
  ];
  if (input.observedOnly) conditions.push(eq(judgmentCalls.outcome, "observed"));
  if (input.companyId) conditions.push(eq(judgmentCalls.companyId, input.companyId));
  const rows = await db
    .select({
      contextId: judgmentCalls.contextId,
      answers: judgmentCalls.answers,
      outcome: judgmentCalls.outcome,
    })
    .from(judgmentCalls)
    .innerJoin(judgmentDefinitions, eq(judgmentCalls.definitionId, judgmentDefinitions.id))
    .where(and(...conditions))
    .orderBy(asc(judgmentCalls.createdAt));
  const latest = new Map<string, LatestCallRow>();
  for (const row of rows) latest.set(row.contextId, { answers: row.answers, outcome: row.outcome });
  return latest;
}

/**
 * [목적] computeAgentJudgmentShadowStats — 섀도 캘리브레이션 비교 통계(조회 전용).
 *   최신 shadow 행/contextId → computeAgentJudgmentShadowVerdict, 같은 contextId 의
 *   최신 v1 행(name "agent-judgment") → answers 중 name "overall" choice 값,
 *   contextId 파싱(/^wfr:([^:]+):step:/) → workflowStepRuns(workflowRunId, stepId)로
 *   정답측 상태를 조회한다. 비율은 0~1, 분모 0 이면 null.
 */
export async function computeAgentJudgmentShadowStats(
  db: Db,
  input: AgentShadowStatsInput = {},
): Promise<AgentShadowStats> {
  const now = input.now ?? new Date();
  const days = input.days ?? 7;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const validatorStepId = input.validatorStepId ?? JEV_VALIDATOR_STEP_ID;
  const qaStepId = input.qaStepId ?? JEV_QA_STEP_ID;
  const confFloor = input.confFloor ?? AGENT_SHADOW_CONF_FLOOR_DEFAULT;

  const v1Latest = await latestCallsByContext(db, {
    companyId: input.companyId,
    cutoff,
    definitionName: AGENT_JUDGMENT_DEFINITION_NAME,
    observedOnly: true,
  });
  const shadowLatest = await latestCallsByContext(db, {
    companyId: input.companyId,
    cutoff,
    definitionName: AGENT_JUDGMENT_SHADOW_DEFINITION_NAME,
    observedOnly: false,
  });

  // judged = 최신 shadow 행이 observed ∧ 계산형 verdict 가 산출되는 행(insufficient 제외).
  const judged = Array.from(shadowLatest.entries()).flatMap(([contextId, row]) => {
    if (row.outcome !== "observed") return [];
    const verdict = computeAgentJudgmentShadowVerdict(row.answers, confFloor);
    if (verdict.verdict === "insufficient_evidence") return [];
    return [{ contextId, verdict: verdict.verdict }];
  });

  const runIds = Array.from(new Set(
    judged.map((row) => parseRunId(row.contextId)).filter((id): id is string => id !== null),
  ));
  const stepRows = runIds.length === 0 ? [] : await db
    .select({
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
    })
    .from(workflowStepRuns)
    .where(and(
      inArray(workflowStepRuns.workflowRunId, runIds),
      inArray(workflowStepRuns.stepId, [validatorStepId, qaStepId]),
    ));
  const truthByRun = new Map<string, { validator: string | null; qa: string | null }>();
  for (const row of stepRows) {
    const entry = truthByRun.get(row.workflowRunId) ?? { validator: null, qa: null };
    if (row.stepId === validatorStepId) entry.validator = row.status;
    else if (row.stepId === qaStepId) entry.qa = row.status;
    truthByRun.set(row.workflowRunId, entry);
  }

  let validatorConfirmed = 0;
  let validatorFailed = 0;
  let validatorUnknown = 0;
  let skipCandidates = 0;
  let candidateMismatches = 0;
  let revisionFamilyJudged = 0;
  let v1LowRisk = 0;
  let v1LowRiskMismatches = 0;
  let agreements = 0;

  for (const row of judged) {
    const runId = parseRunId(row.contextId);
    const truth = runId === null ? undefined : truthByRun.get(runId);
    const groundTruth = computeAgentShadowGroundTruth(truth?.validator ?? null, truth?.qa ?? null);
    if (groundTruth === "success") validatorConfirmed += 1;
    else if (groundTruth === "failed") validatorFailed += 1;
    else validatorUnknown += 1;
    if (row.verdict === "low_risk") {
      skipCandidates += 1;
      if (groundTruth === "failed") candidateMismatches += 1;
    }
    if (groundTruth === "failed") revisionFamilyJudged += 1;
    const v1Overall = readOverallChoice(v1Latest.get(row.contextId)?.answers);
    if (v1Overall === "low_risk") {
      v1LowRisk += 1;
      if (groundTruth === "failed") v1LowRiskMismatches += 1;
    }
    // v1 overall 값 도메인(low_risk|needs_full_review|insufficient_evidence)과 v2 등급의 문자열 일치.
    if (v1Overall === row.verdict) agreements += 1;
  }

  return {
    windowDays: days,
    companyId: input.companyId ?? null,
    totalPrescreens: v1Latest.size,
    shadowed: shadowLatest.size,
    judged: judged.length,
    validatorConfirmed,
    validatorFailed,
    validatorUnknown,
    skipCandidates,
    skipCandidateRate: judged.length === 0 ? null : skipCandidates / judged.length,
    candidateMismatches,
    candidateMismatchRate: skipCandidates === 0 ? null : candidateMismatches / skipCandidates,
    revisionFamilyJudged,
    missRate: revisionFamilyJudged === 0 ? null : candidateMismatches / revisionFamilyJudged,
    v1LowRisk,
    v1LowRiskMismatches,
    v2v1AgreementRate: judged.length === 0 ? null : agreements / judged.length,
  };
}
