// server/src/services/workflow/control-flow/qa-remediation-preparation-contract.ts
//
// [purpose] Stage B1 — legacy QA 기계 remediation 의 "적용 전 예약(preparation)" 기록 계약.
//   기존 legacy 경로는 wake 선행 + 직접 파일 기록이라, 기록 실패 이후에도 판정은 이미 소비되어
//   producer 재작업으로 빠졌다(StageA6 RED). 이 계약은 수정 적용 전 상태를 workflowTransitionEvents
//   한 행(예약)으로 남겨, B2 재개 경로가 부분 진행 상태를 식별·이어받게 하는 첫 단계다.
//
// [authority] rule 8/9 — 오직 기계 생성·버전 지정·schema 검증 계약만 다룬다. 파싱은 서버 발행,
//   발행 시점 파일 bytes, 배타적 파일시스템 쓰기 권한 그 무엇도 증명하지 않는다. 예약 기록은
//   예외적 쓰기 권한의 증거가 아니며 자연어(reason/comment)는 결코 권위가 아니다. mutation API는
//   이 단계에 없다(B2 소관).
//
// [safety] 순수 함수만 둔다(파일 IO/wake 없음). 행 검증은 실제 workflowTransitionEvents 열을
//   구조적으로 그대로 받아 scope/type/layer/idempotencyKey 를 payload 와 대조하고, 불일치·중복
//   참조·누락/과잉 파일 참조를 invalid 로, 정상이지만 현재 시도와 다른 기록은 stale 로 구분해
//   absent 와 절대 혼동되지 않게 한다(fail-visible). 문자열 강제 변환(coercion)은 하지 않는다.

import path from "node:path";
import { z } from "zod";
import { workflowQaRemediationsSchema } from "@paperclipai/shared";
import { hashQaCorrectionPayload, qaCorrectionAttemptSchema, type QaCorrectionAttempt } from "./qa-correction-contract.js";
import {
  QA_REMEDIATION_EVENT_TYPE, QA_REMEDIATION_MAX_FILE_BYTES, remediationIdempotencyKey,
} from "./qa-remediation-contract.js";
import {
  qaRemediationQualityBindingHash, qaRemediationQualityBindingSchema, qualityBindingMatchesPreparation,
} from "./qa-remediation-quality-binding.js";

export const QA_REMEDIATION_PREPARATION_EVENT_TYPE = "qa_remediation_prepared";
export const QA_REMEDIATION_PREPARATION_SCHEMA_VERSION = "workflow.qa-remediation.prepare.v2";
export const QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 = "workflow.qa-remediation.prepare.v3";

export class QaRemediationPreparationError extends Error {
  constructor(readonly reason: string) { super(`qa_remediation_preparation_${reason}`); }
}

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().safe().nonnegative();
const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const boundedBytes = count.max(QA_REMEDIATION_MAX_FILE_BYTES);

/** [canonical identity] 절대경로 + resolve 불변(정규화 필요 없는 표현) — 강제 변환 없이 거부한다. */
const canonicalAbsoluteFile = text.refine(
  (file) => path.isAbsolute(file) && path.resolve(file) === file,
  "qa_remediation_file_not_canonical",
);

/** 공식 verdict 원천 1건 — eventId/heartbeatRunId + 정확 QA 시도 tuple + 원본 순서 그대로의 items + hash 결합. */
export const qaRemediationVerdictSchema = z.object({
  eventId: uuid,
  heartbeatRunId: uuid,
  qa: qaCorrectionAttemptSchema,
  items: workflowQaRemediationsSchema.shape.items,
  remediationsHash: sha256,
}).strict().refine((v) => hashQaCorrectionPayload(v.items) === v.remediationsHash, "qa_remediation_items_hash_mismatch");

/** 적용 대상 파일 신원 — 이전/이후 sha256, 원본(before) 크기 2MB 상한. 구조 검증일 뿐 현재 bytes 를 증명하지 않는다. */
export const qaRemediationFileSchema = z.object({
  path: canonicalAbsoluteFile,
  beforeSha256: sha256,
  afterSha256: sha256,
  /** [2MB 상한은 적용 전 원본에만] 수정 후 크기는 안전한 음이 아닌 정수만 요구한다(정상적 증가 허용). */
  beforeByteSize: boundedBytes,
  afterByteSize: count,
}).strict();

const unique = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
/**
 * files-to-item 정확 커버 — item.file 은 절대경로면 비정규 표현(legacy path.resolve 허용 분)도 인정하되
 * 원본 문자열·순서·hash 는 그대로 두고 resolve 결과만 식별자와 비교한다. 상대경로는 거부.
 */
const itemFilesExact = (verdicts: readonly z.infer<typeof qaRemediationVerdictSchema>[], files: readonly { path: string }[]) => {
  const identities = new Set(files.map((f) => f.path));
  const referenced = new Set(verdicts.flatMap((v) => v.items.map((item) => {
    if (!path.isAbsolute(item.file)) return null;
    return path.resolve(item.file);
  })));
  if (referenced.has(null)) return false;
  return identities.size === files.length && identities.size === referenced.size && [...referenced].every((f) => identities.has(f as string));
};

const qaRemediationPreparationFields = {
  preparationId: uuid,
  companyId: uuid,
  missionId: uuid,
  workflowRunId: uuid,
  dispatchAuthorityVersion: count,
  producer: qaCorrectionAttemptSchema,
  verdicts: z.array(qaRemediationVerdictSchema).min(1),
  files: z.array(qaRemediationFileSchema).min(1),
  preparedAt: timestamp,
};
const qaRemediationPreparationV2Schema = z.object({
  schemaVersion: z.literal(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION), ...qaRemediationPreparationFields,
}).strict();
const qaRemediationPreparationV3Schema = z.object({
  schemaVersion: z.literal(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3), ...qaRemediationPreparationFields,
  qualityBinding: qaRemediationQualityBindingSchema,
}).strict();
export const qaRemediationPreparationSchema = z.discriminatedUnion("schemaVersion", [
  qaRemediationPreparationV2Schema, qaRemediationPreparationV3Schema,
]).superRefine((p, ctx) => {
  if (!(unique(p.verdicts, (v) => v.eventId) && unique(p.verdicts, (v) => v.heartbeatRunId)
    && unique(p.verdicts, (v) => v.qa.stepRunId) && unique(p.files, (f) => f.path)
    && itemFilesExact(p.verdicts, p.files))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "qa_remediation_preparation_references" });
  if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
    && !qualityBindingMatchesPreparation(p.qualityBinding, p)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "qa_remediation_quality_binding_references" });
  }
});

export type QaRemediationVerdict = z.infer<typeof qaRemediationVerdictSchema>;
export type QaRemediationFileIdentity = z.infer<typeof qaRemediationFileSchema>;
export type QaRemediationPreparation = z.infer<typeof qaRemediationPreparationSchema>;

/** legacy writeQaRemediationPatches 행 payload — unknown 추가 필드(signatures/writeError/Quality 확장) 허용. */
export const qaRemediationLegacyAppliedPayloadSchema = z.object({
  kind: z.literal(QA_REMEDIATION_EVENT_TYPE),
  outcome: z.enum(["applied", "write_failed"]),
  producerStepId: text,
  producerStepRunId: uuid,
  producerIteration: count,
  qaStepId: text,
  sourceVerdictEventId: uuid,
  appliedAt: timestamp,
  items: workflowQaRemediationsSchema.shape.items,
});

export interface QaRemediationEventRow {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
  readonly workflowRunId: string | null;
  readonly workflowStepRunId: string | null;
  readonly issueId: string | null;
  readonly heartbeatRunId: string | null;
  readonly executionGeneration: number | null;
  readonly eventType: string;
  readonly layer: string;
  readonly decision: string | null;
  readonly verdict: string | null;
  readonly reason: string | null;
  readonly reasonCode: string | null;
  readonly idempotencyKey: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

/** 현재 사이클 판정 기준 — 정확 시도 매칭에 필요한 최소 원천(tuple 전체 일치 요구). */
export interface QaRemediationVerdictRef {
  readonly eventId: string;
  readonly heartbeatRunId: string;
  readonly qa: QaCorrectionAttempt;
  readonly remediationsHash: string;
}

export interface QaRemediationPreparationScope {
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowRunId: string;
  /** 현재 발행 권한 버전 — 예약 기록과 정확 일치해야 prepared 다. */
  readonly dispatchAuthorityVersion: number;
  readonly producer: QaCorrectionAttempt;
  readonly verdicts: readonly QaRemediationVerdictRef[];
  /** Root-derived current Quality identity; absent for the existing workflow-only caller. */
  readonly qualityBinding?: { readonly actionId: string; readonly bindingHash: string };
}

/** 예약 idempotencyKey — 같은 (scope, producer 시도, verdict 집합) 의 재시도는 같은 예약이 되도록 결정론적. */
export function qaRemediationPreparationKey(p: Pick<QaRemediationPreparation, "companyId" | "workflowRunId" | "verdicts"> & { producer: { stepRunId: string } }): string {
  return `qa-remediation-prepared:${p.companyId}:${p.workflowRunId}:${p.producer.stepRunId}:${p.verdicts.map((v) => v.eventId).sort().join("+")}`;
}

export function parseQaRemediationPreparation(payload: unknown): QaRemediationPreparation {
  return qaRemediationPreparationSchema.parse(payload);
}

const sameAttempt = (a: QaCorrectionAttempt, b: QaCorrectionAttempt) =>
  a.stepRunId === b.stepRunId && a.stepId === b.stepId && a.issueId === b.issueId
  && a.executionGeneration === b.executionGeneration && a.retryCount === b.retryCount && a.iterationIndex === b.iterationIndex;
const sameVerdict = (a: QaRemediationVerdictRef, b: QaRemediationVerdict) =>
  a.eventId === b.eventId && a.heartbeatRunId === b.heartbeatRunId && a.remediationsHash === b.remediationsHash && sameAttempt(a.qa, b.qa);

export type ClassifiedQaRemediationPreparationRow =
  | { kind: "prepared"; eventId: string; preparation: QaRemediationPreparation }
  | { kind: "stale"; eventId: string; preparation: QaRemediationPreparation; payloadScopeMatches: boolean; detail: string }
  | { kind: "invalid"; eventId: string | null; detail: string };

/** 행 봉투(scope/type/layer/idempotencyKey) 를 payload 와 대조하고 현재 시도와의 관계를 분류한다. */
export function classifyQaRemediationPreparationRow(row: QaRemediationEventRow, scope: QaRemediationPreparationScope): ClassifiedQaRemediationPreparationRow {
  const invalid = (detail: string): ClassifiedQaRemediationPreparationRow => ({ kind: "invalid", eventId: row.id, detail });
  if (row.eventType !== QA_REMEDIATION_PREPARATION_EVENT_TYPE) return invalid("event_type");
  if (row.layer !== "workflow_validation") return invalid("layer");
  let p: QaRemediationPreparation;
  try { p = parseQaRemediationPreparation(row.payload); } catch { return invalid("payload"); }
  if (row.id !== p.preparationId) return invalid("preparation_id");
  if (row.companyId !== p.companyId || row.missionId !== p.missionId || row.workflowRunId !== p.workflowRunId) return invalid("row_scope");
  if (row.workflowStepRunId !== p.producer.stepRunId || row.issueId !== p.producer.issueId || row.executionGeneration !== p.producer.executionGeneration) return invalid("row_producer");
  if (row.idempotencyKey !== qaRemediationPreparationKey(p)) return invalid("idempotency_key");
  const payloadScopeMatches = p.companyId === scope.companyId && p.missionId === scope.missionId && p.workflowRunId === scope.workflowRunId;
  if (!payloadScopeMatches) return { kind: "stale", eventId: row.id, preparation: p, payloadScopeMatches, detail: "preparation payload scope differs from query scope" };
  if (!sameAttempt(p.producer, scope.producer)) return { kind: "stale", eventId: row.id, preparation: p, payloadScopeMatches, detail: "producer attempt tuple differs from current attempt" };
  if (p.dispatchAuthorityVersion !== scope.dispatchAuthorityVersion) return { kind: "stale", eventId: row.id, preparation: p, payloadScopeMatches, detail: "dispatch authority version differs from current authority" };
  const matched = scope.verdicts.filter((v) => p.verdicts.some((pv) => sameVerdict(v, pv)));
  if (matched.length !== scope.verdicts.length || p.verdicts.length !== scope.verdicts.length) {
    return { kind: "stale", eventId: row.id, preparation: p, payloadScopeMatches, detail: `verdict attempt set differs (${matched.length}/${scope.verdicts.length} current verdicts covered)` };
  }
  if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION && scope.qualityBinding) return invalid("quality_binding_missing");
  if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 && (!scope.qualityBinding
    || p.qualityBinding.actionId !== scope.qualityBinding.actionId
    || qaRemediationQualityBindingHash(p.qualityBinding) !== scope.qualityBinding.bindingHash)) return invalid("quality_binding_scope");
  return { kind: "prepared", eventId: row.id, preparation: p };
}

export type ClassifiedQaRemediationLegacyRow =
  | { kind: "legacy_effect"; eventId: string; effect: QaRemediationLegacyEffect; scoped: true; qaStepRunId: string; sourceVerdictEventId: string; remediationsHash: string; producerStepRunId: string; producerStepId: string; producerIteration: number }
  | { kind: "stale"; eventId: string | null; detail: string; scoped: boolean; qaStepRunId: string | null; sourceVerdictEventId: string | null; remediationsHash: string | null; producerStepRunId: string | null; producerStepId: string | null; producerIteration: number | null }
  | { kind: "invalid"; eventId: string | null; detail: string };

/** legacy qa_remediation_applied(applied/write_failed 포함) — 불확실한 '이미 시도됨' 증거일 뿐 재생·재적용 권한은 아니다. */
export interface QaRemediationLegacyEffect {
  readonly eventId: string;
  readonly outcome: "applied" | "write_failed";
  readonly sourceVerdictEventId: string;
  readonly qaStepRunId: string;
  readonly qaStepId: string;
  readonly producerStepRunId: string;
  readonly remediationsHash: string;
  readonly appliedAt: string;
}

export function classifyQaRemediationLegacyRow(row: QaRemediationEventRow, scope: QaRemediationPreparationScope): ClassifiedQaRemediationLegacyRow {
  const invalid = (detail: string): ClassifiedQaRemediationLegacyRow => ({ kind: "invalid", eventId: row.id, detail });
  const stale = (detail: string, parsed?: { sourceVerdictEventId: string; items: unknown[]; producerStepRunId: string; producerStepId: string; producerIteration: number }): ClassifiedQaRemediationLegacyRow => ({
    kind: "stale", eventId: row.id, detail, scoped: row.companyId === scope.companyId && row.workflowRunId === scope.workflowRunId,
    qaStepRunId: row.workflowStepRunId ?? null,
    sourceVerdictEventId: parsed?.sourceVerdictEventId ?? null,
    remediationsHash: parsed ? hashQaCorrectionPayload(parsed.items) : null,
    producerStepRunId: parsed?.producerStepRunId ?? null,
    producerStepId: parsed?.producerStepId ?? null, producerIteration: parsed?.producerIteration ?? null,
  });
  if (row.eventType !== QA_REMEDIATION_EVENT_TYPE) return invalid("event_type");
  if (row.layer !== "workflow_validation" || row.verdict !== "request_changes" || row.reason !== "workflow_api" || row.reasonCode !== "qa_remediation") return invalid("envelope");
  if (!row.workflowStepRunId) return invalid("qa_step_run");
  let b: z.infer<typeof qaRemediationLegacyAppliedPayloadSchema>;
  try { b = qaRemediationLegacyAppliedPayloadSchema.parse(row.payload); } catch { return invalid("payload"); }
  // decision 은 outcome 과 정확히 일치해야 한다(불 일치 동치 아님 — 제3의 값/null 도 invalid).
  const expectedDecision = b.outcome === "write_failed" ? "mechanical_remediation_write_failed" : "mechanical_remediation_applied";
  if (row.decision !== expectedDecision) return invalid("decision_outcome");
  if (row.idempotencyKey !== remediationIdempotencyKey(row.companyId, row.workflowStepRunId, b.sourceVerdictEventId)) return invalid("idempotency_key");
  if (row.companyId !== scope.companyId || row.workflowRunId !== scope.workflowRunId || row.missionId !== scope.missionId) return stale("legacy row outside query scope", b);
  const ref = scope.verdicts.find((v) => v.eventId === b.sourceVerdictEventId && v.qa.stepRunId === row.workflowStepRunId);
  const hash = hashQaCorrectionPayload(b.items);
  if (!ref || ref.remediationsHash !== hash || b.producerStepRunId !== scope.producer.stepRunId) {
    return stale("legacy row bound to another verdict/producer attempt", b);
  }
  // 여기까지 verdict+producer stepRun 이 현재와 일치 — 남은 저장 봉투가 현재 refs 와 모순되면 불가능 상태(파손)다.
  if (b.qaStepId !== ref.qa.stepId || row.issueId !== ref.qa.issueId) return invalid("qa_binding");
  if (b.producerStepId !== scope.producer.stepId || b.producerIteration !== scope.producer.iterationIndex) return invalid("producer_binding");
  if (row.heartbeatRunId !== null && row.heartbeatRunId !== ref.heartbeatRunId) return stale("legacy verdict execution envelope differs from current verdict heartbeat", b);
  return { kind: "legacy_effect", eventId: row.id, effect: {
    eventId: row.id, outcome: b.outcome, sourceVerdictEventId: b.sourceVerdictEventId, qaStepRunId: row.workflowStepRunId,
    qaStepId: b.qaStepId, producerStepRunId: b.producerStepRunId, remediationsHash: hash, appliedAt: b.appliedAt,
  }, scoped: true, qaStepRunId: row.workflowStepRunId, sourceVerdictEventId: b.sourceVerdictEventId, remediationsHash: hash, producerStepRunId: b.producerStepRunId, producerStepId: b.producerStepId, producerIteration: b.producerIteration };
}

/**
 * 원본 QA 시도 상한용 예약 수 — 미완료 preparation 도 distinct 로 센다(crash 후 재시도 무한 방지).
 * 상한은 QA stepRun 기준(생산자 시도마다 리셋 아님) — 이전 producer 세대/iteration 의 예약도 모두 센다.
 * 이중 계산(제거)만 legacy↔preparation 정확 대응(가용 producer tuple+verdict eventId+items hash)으로 하고,
 * 다른 producer iteration 의 같은 verdict+hash 는 별도 시도로 센다. invalid 행은 귀속 불명이라 세지
 * 않고 집계 상태(invalid)가 입장을 막는다. 이 값은 증거이며 실행 결정 자체는 아니다(B2 소관).
 */
export function countQaRemediationReservations(
  preparations: readonly ClassifiedQaRemediationPreparationRow[],
  legacy: readonly ClassifiedQaRemediationLegacyRow[],
  scope: QaRemediationPreparationScope,
): Map<string, number> {
  const scoped = preparations.flatMap((c) =>
    c.kind === "invalid" || (c.kind === "stale" && !c.payloadScopeMatches) ? [] : [c.preparation]);
  const counts = new Map<string, number>();
  for (const verdict of scope.verdicts) {
    const coveringPreps = scoped.filter((p) => p.verdicts.some((v) => v.qa.stepRunId === verdict.qa.stepRunId));
    const covering = new Set(coveringPreps.map((p) => p.preparationId));
    let legacyAttempts = 0;
    for (const row of legacy) {
      if (row.kind === "invalid" || !row.scoped || row.qaStepRunId !== verdict.qa.stepRunId) continue;
      const rowProducer = row.producerStepRunId;
      const mapped = rowProducer !== null && coveringPreps.some((p) => p.producer.stepRunId === rowProducer
        && p.producer.stepId === row.producerStepId && p.producer.iterationIndex === row.producerIteration
        && p.verdicts.some((v) => v.qa.stepRunId === verdict.qa.stepRunId && v.eventId === row.sourceVerdictEventId && v.remediationsHash === row.remediationsHash));
      if (!mapped) legacyAttempts += 1;
    }
    counts.set(verdict.qa.stepRunId, covering.size + legacyAttempts);
  }
  return counts;
}
