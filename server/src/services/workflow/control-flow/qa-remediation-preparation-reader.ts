// server/src/services/workflow/control-flow/qa-remediation-preparation-reader.ts
//
// [purpose] Stage B1 — workflowTransitionEvents 의 qa_remediation_prepared(v2) 예약과 scoped legacy
//   qa_remediation_applied(applied/write_failed) 증거를 읽어 현재 remediation 사이클 상태를 typed 결과로
//   노출한다. B2 통합이 malformed 행·과거 효과·과거 사이클 흔적을 absent 로 오인하지 않게 한다.
//
// [authority] SELECT 전용 — mutation/wake/파일 IO 없다. 분류·집계는 순수 helper(contract 위임) 가 하고
//   실제 DB 오류는 그대로 전파한다(typed invalid 로 지워 absent 가 되게 하지 않는다). legacy 증거는
//   불확실한 '이미 시도됨' evidence 일 뿐 재적용(replay) 권한이 아니다. stale 는 이전 사이클 증거일
//   뿐 새 사이클을 영구 차단하는 정책이 아니다 — 정확 사이클 계속 여부는 B2 completion reconciliation 이 정한다.
//
// [scope] 관련성 경계: preparation 은 행 workflowStepRunId=producer 시도, legacy 는 현재 QA stepRun 집합으로
//   좁힌다(무관 분기 확산 금지). mission 은 SQL 이 아닌 분류기에서 대조해 불일치 행을 '현재 아님'으로 노출한다.
//   관련 invalid/충돌은 항상 prepared 보다 우선해 preparation=null 로 보고된다(숨기지 않는다).

import { and, eq, inArray } from "drizzle-orm";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import { QA_REMEDIATION_EVENT_TYPE } from "./qa-remediation-contract.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE,
  classifyQaRemediationLegacyRow, classifyQaRemediationPreparationRow, countQaRemediationReservations,
  type ClassifiedQaRemediationLegacyRow, type ClassifiedQaRemediationPreparationRow,
  type QaRemediationEventRow, type QaRemediationLegacyEffect, type QaRemediationPreparation,
  type QaRemediationPreparationScope,
} from "./qa-remediation-preparation-contract.js";

export type QaRemediationPreparationStatus =
  /** 관련 행이 구조적으로 손상/불일치 또는 매칭 충돌 — unknown, 입장 불가 홀드. prepared 보다 우선. */
  | "invalid"
  /** 현재 verdict 에 대한 scoped legacy 적용/실패 증거 — 불확실 already-effected, 절대 재적용 권한 아님. */
  | "legacy_effect"
  /** 현재 producer/verdict/권한 버전에 정확히 대응하는 유효 예약 1건(B2 가 이어받는다). */
  | "prepared"
  /** 정상 관련 행이 현재 시도와 불일치(이전 사이클) — absent 와 구분되는 '증거'. 차단 정책은 B2 소관. */
  | "stale"
  /** 관련 행이 전혀 없다 — 새 예약 가능. */
  | "absent";

export interface QaRemediationPreparationRead {
  readonly status: QaRemediationPreparationStatus;
  /** 단일 정확 매칭이 있을 때만 채운다(충돌/invalid 면 null). */
  readonly preparationEventId: string | null;
  readonly preparation: QaRemediationPreparation | null;
  /** 현재 verdict 에 부합하는 scoped legacy 증거(applied/write_failed 포함, 불확실 already-effected). */
  readonly legacyEffects: readonly QaRemediationLegacyEffect[];
  /** 손상/불일치/충돌 — invalid 가 absent 나 prepared 로 축소되지 않게 그대로 노출. */
  readonly invalidRows: readonly { eventId: string | null; detail: string }[];
  /** 정상이지만 현재 시도와 불일치한 관련 행의 사유(이전 사이클 증거). */
  readonly staleDetails: readonly string[];
  /** qaStepRunId → distinct 예약 수(미완료 포함, 이중 계산 방지 규칙은 contract 참조). 상한 비교·실행 결정은 호출자(B2). */
  readonly reservationCounts: ReadonlyMap<string, number>;
  readonly detail: string;
}

/** [pure] 관련 행만 받는 집계 — 경계 밖(다른 producer/QA step) 행은 배제하고, 관련 invalid/충돌이 prepared 를 이긴다. */
export function aggregateQaRemediationPreparationRead(
  preparationRows: readonly QaRemediationEventRow[],
  legacyRows: readonly QaRemediationEventRow[],
  scope: QaRemediationPreparationScope,
): QaRemediationPreparationRead {
  const qaStepRunIds = new Set(scope.verdicts.map((v) => v.qa.stepRunId));
  const relevantPreparations = preparationRows.filter((row) => row.workflowStepRunId === scope.producer.stepRunId);
  const relevantLegacy = legacyRows.filter((row) => row.workflowStepRunId !== null && qaStepRunIds.has(row.workflowStepRunId));
  const preparations = relevantPreparations.map((row) => classifyQaRemediationPreparationRow(row, scope));
  const legacy = relevantLegacy.map((row) => classifyQaRemediationLegacyRow(row, scope));

  const matches = preparations.filter((c): c is Extract<ClassifiedQaRemediationPreparationRow, { kind: "prepared" }> => c.kind === "prepared");
  const legacyEffects = legacy.flatMap((c) => c.kind === "legacy_effect" ? [c.effect] : []);
  const invalidRows = [
    ...preparations.flatMap((c) => c.kind === "invalid" ? [{ eventId: c.eventId, detail: `preparation:${c.detail}` }] : []),
    ...legacy.flatMap((c) => c.kind === "invalid" ? [{ eventId: c.eventId, detail: `legacy:${c.detail}` }] : []),
  ];
  const staleDetails = [
    ...preparations.flatMap((c) => c.kind === "stale" ? [`preparation:${c.detail}`] : []),
    ...legacy.flatMap((c) => c.kind === "stale" ? [`legacy:${c.detail}`] : []),
  ];
  const reservationCounts = countQaRemediationReservations(preparations, legacy, scope);
  const single = matches.length === 1 ? matches[0]! : null;

  let status: QaRemediationPreparationStatus;
  let detail: string;
  if (invalidRows.length > 0) { status = "invalid"; detail = `${invalidRows.length} malformed/inconsistent/conflicting row(s) in scope`; }
  else if (matches.length > 1) { status = "invalid"; detail = `${matches.length} conflicting matching preparations`; }
  else if (legacyEffects.length > 0) { status = "legacy_effect"; detail = `${legacyEffects.length} scoped legacy effect(s) for current verdicts (uncertain already-effected)`; }
  else if (single) { status = "prepared"; detail = `matching preparation reserved for ${scope.verdicts.length} verdict(s)`; }
  else if (staleDetails.length > 0) { status = "stale"; detail = `${staleDetails.length} prior-cycle row(s) in scope (evidence only, not a block policy)`; }
  else { status = "absent"; detail = "no preparation or legacy remediation rows in scope"; }

  return {
    status,
    // invalid/충돌에는 단일 매칭이 있어도 preparation 을 비운다 — 오류를 prepared 안에 숨기지 않는다.
    preparationEventId: status === "invalid" ? null : single?.eventId ?? null,
    preparation: status === "invalid" ? null : single?.preparation ?? null,
    legacyEffects,
    invalidRows,
    staleDetails,
    reservationCounts,
    detail,
  };
}

/** SELECT-only. DB 오류는 그대로 throw 한다(absent 로 변환하지 않는다). 집계는 순수 helper 에 위임. */
export async function readQaRemediationPreparation(
  db: Pick<Db, "select">,
  scope: QaRemediationPreparationScope,
): Promise<QaRemediationPreparationRead> {
  const preparationRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scope.companyId),
    eq(workflowTransitionEvents.workflowRunId, scope.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, scope.producer.stepRunId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ));
  const legacyRows = scope.verdicts.length === 0 ? [] : await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scope.companyId),
    eq(workflowTransitionEvents.workflowRunId, scope.workflowRunId),
    inArray(workflowTransitionEvents.workflowStepRunId, scope.verdicts.map((v) => v.qa.stepRunId)),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE),
  ));
  return aggregateQaRemediationPreparationRead(preparationRows, legacyRows, scope);
}
