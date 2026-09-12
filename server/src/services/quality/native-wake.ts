// server/src/services/quality/native-wake.ts
//
// [purpose] T4 quality 실행 깨우기 키 계약과 수락 증거 판독. 키는 정확한
//   (actionId, stepRunId, generation, attempt) 시도를 가리키며 통신 재전송은 같은
//   키, 새 기술 시도는 새 키를 쓴다. 수락 판정은 admission tx 가 기록한
//   qualityAcceptance 원문만 근거로 삼는다(빠른 완료 뒤에도 보존).
// [authority] agent_wakeup_requests 행 + qualityAcceptance JSON. helper 의 true,
//   행 존재, queued 문자열만으로 수락을 만들지 않는다.

import { and, asc, eq, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const QUALITY_WAKE_PREFIX = "quality-action-wake:";

export function qualityWakeKey(x: {
  actionId: string; stepRunId: string; generation: number; attempt: number;
}): string {
  if (!Number.isSafeInteger(x.generation) || x.generation < 0
      || !Number.isSafeInteger(x.attempt) || x.attempt < 1)
    throw new Error("quality_invalid_attempt");
  return `quality-action-wake:${x.actionId}:${x.stepRunId}:g${x.generation}:a${x.attempt}`;
}

export type ParsedQualityWakeKey = {
  actionId: string; stepRunId: string; generation: number; attempt: number;
};

const KEY_RE = /^quality-action-wake:([^:]+):([^:]+):g(\d+):a(\d+)$/;

export function parseQualityWakeKey(key: string | null | undefined): ParsedQualityWakeKey | null {
  if (typeof key !== "string") return null;
  const match = KEY_RE.exec(key);
  if (!match) return null;
  return { actionId: match[1]!, stepRunId: match[2]!, generation: Number(match[3]), attempt: Number(match[4]) };
}

export function isQualityWakeKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(QUALITY_WAKE_PREFIX);
}

// [T8 bounded resubmission] PLAN-QA 재제출 wake 키. 품질 조치(qualityActions)가 아닌 검토
//   이슈의 유한 재제출 예약 원장(qualityContract.dispatches)을 가리킨다. 통신 재전송은 같은 키,
//   새 검토 시도 예약은 새 attempt 키를 쓴다.
export const PLAN_QA_RESUBMIT_WAKE_PREFIX = "plan-qa-resubmit:";

export type ParsedPlanQaResubmissionWakeKey = {
  issueId: string; decisionHash: string; generation: number; attempt: number;
};

const PLAN_QA_KEY_RE = /^plan-qa-resubmit:([0-9a-f-]{36}):([0-9a-f]{64}):g(\d+):a(\d+)$/;

export function planQaResubmissionWakeKey(x: {
  issueId: string; decisionHash: string; generation: number; attempt: number;
}): string {
  if (!Number.isSafeInteger(x.generation) || x.generation < 0
      || !Number.isSafeInteger(x.attempt) || x.attempt < 1)
    throw new Error("quality_invalid_attempt");
  return `plan-qa-resubmit:${x.issueId}:${x.decisionHash}:g${x.generation}:a${x.attempt}`;
}

export function parsePlanQaResubmissionWakeKey(key: string | null | undefined): ParsedPlanQaResubmissionWakeKey | null {
  if (typeof key !== "string") return null;
  const match = PLAN_QA_KEY_RE.exec(key);
  if (!match) return null;
  return { issueId: match[1]!, decisionHash: match[2]!, generation: Number(match[3]), attempt: Number(match[4]) };
}

/** 병합·coalesce 금지 대상 키: 품질 조치 wake 와 PLAN-QA 재제출 wake. */
export function isBoundedExecutionWakeKey(key: string | null | undefined): boolean {
  return isQualityWakeKey(key)
    || (typeof key === "string" && key.startsWith(PLAN_QA_RESUBMIT_WAKE_PREFIX));
}

export type QualityAttemptRow = {
  id: string;
  idempotencyKey: string | null;
  status: string;
  runId: string | null;
  qualityAcceptance: Record<string, unknown> | null;
  requestedAt: Date;
};

/** 특정 step 실행에 만들어진 모든 quality 시도 행(시도 번호 순 정렬 아님 — 파싱으로 판단). */
export async function qualityAttemptRows(db: Db, input: { companyId: string; actionId: string; stepRunId: string }): Promise<QualityAttemptRow[]> {
  return db.select({
    id: agentWakeupRequests.id,
    idempotencyKey: agentWakeupRequests.idempotencyKey,
    status: agentWakeupRequests.status,
    runId: agentWakeupRequests.runId,
    qualityAcceptance: agentWakeupRequests.qualityAcceptance,
    requestedAt: agentWakeupRequests.requestedAt,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    like(agentWakeupRequests.idempotencyKey, `${QUALITY_WAKE_PREFIX}${input.actionId}:${input.stepRunId}:%`),
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
}

export async function findQualityWakeRowByExactKey(db: Db, input: { companyId: string; idempotencyKey: string }): Promise<QualityAttemptRow | null> {
  const [row] = await db.select({
    id: agentWakeupRequests.id,
    idempotencyKey: agentWakeupRequests.idempotencyKey,
    status: agentWakeupRequests.status,
    runId: agentWakeupRequests.runId,
    qualityAcceptance: agentWakeupRequests.qualityAcceptance,
    requestedAt: agentWakeupRequests.requestedAt,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  return row ?? null;
}

export type QualityDeliveryOutcome = { status: "accepted" | "waiting" | "blocked"; receiptId: string | null };

const LIVE_ROW_STATUSES = new Set(["queued", "claimed", "deferred_issue_execution"]);

/**
 * 저장 행을 전달 결과로 판독한다. 수락은 오직 admission tx 가 기록한 qualityAcceptance
 * 원문(heartbeatRunId 포함)으로만 성립한다. 대기 상태 행은 waiting, 거절(skipped·failed)
 * 행은 acceptance 없이 blocked 다.
 */
export function mapQualityWakeRow(row: Pick<QualityAttemptRow, "id" | "status" | "qualityAcceptance">): QualityDeliveryOutcome {
  if (row.qualityAcceptance && typeof row.qualityAcceptance === "object") {
    return { status: "accepted", receiptId: row.id };
  }
  if (LIVE_ROW_STATUSES.has(row.status)) {
    return { status: "waiting", receiptId: row.id };
  }
  return { status: "blocked", receiptId: null };
}

/** 재시도 발송용 다음 quality wake 키: 현재 generation 의 시도 행 수 + 1(유한 재시도 예약 후 새 키). */
export async function nextQualityRetryWakeKey(db: Db, input: {
  companyId: string; actionId: string; stepRunId: string; generation: number;
}): Promise<string> {
  const rows = await qualityAttemptRows(db, input);
  const atGeneration = rows.filter((row) => {
    const parsed = parseQualityWakeKey(row.idempotencyKey);
    return parsed !== null && parsed.generation === input.generation;
  });
  return qualityWakeKey({ ...input, attempt: atGeneration.length + 1 });
}
