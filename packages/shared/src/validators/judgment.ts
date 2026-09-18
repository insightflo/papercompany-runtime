import { z } from "zod";

/**
 * 판단 계층 검증 (트랙 B-1).
 *
 * - 질문 type 은 'choice' | 'score' | 'noul' 만 허용 (text + 검증).
 * - judgmentDefinitionSnapshotSchema 는 judgment_definitions.definition jsonb 의
 *   구조 계약이다. 정의 저장/수정 경로(B-2 라우트)가 이 스키마로 거절한다.
 * - outcome 은 'executed' | 'observed' | 'error' | 'disabled' | 'blocked'.
 *   'blocked' 는 반출 통제 거부 — 재시도·원문 폴백 금지.
 */

export const judgmentQuestionTypeSchema = z.enum(["choice", "score", "noul"]);

/**
 * criteria — 공식 SDK 계약 반영(트랙 B-2).
 * string(레거시) | choice/noul 용 {라벨: 설명} 맵 | score 용 루브릭 배열.
 * 상세는 shared/types/judgment.ts 의 JudgmentQuestionCriteria 주석.
 */
export const judgmentQuestionCriteriaSchema = z.union([
  z.string(),
  z.record(z.string(), z.union([z.string(), z.null()])),
  z.array(z.union([z.string(), z.null()])),
]);

export const judgmentQuestionSchema = z
  .object({
    name: z.string().min(1),
    type: judgmentQuestionTypeSchema,
    instructions: z.string().min(1),
    criteria: judgmentQuestionCriteriaSchema.optional(),
  })
  .strict();

export const judgmentDefinitionSnapshotSchema = z
  .object({
    description: z.string().min(1),
    /** 질문 묶음의 단일 목적. 선택 필드 — 하나의 정의 = 하나의 purpose. */
    purpose: z.string().min(1).optional(),
    /** 출처 등급 메타. "secret" 정의는 호출 자체가 차단된다(집행점 judgment-service). */
    originClass: z.enum(["internal", "public", "secret"]).optional(),
    stateAssembly: z
      .object({
        kind: z.literal("inline-ref"),
        notes: z.string(),
      })
      .strict(),
    questions: z.array(judgmentQuestionSchema).min(1),
    policy: z
      .object({
        notes: z.string(),
        thresholds: z.record(z.number()),
      })
      .strict(),
  })
  .strict();

export const judgmentCallOutcomeSchema = z.enum([
  "executed",
  "observed",
  "error",
  "disabled",
  "blocked",
]);

export const judgmentEgressFindingSchema = z
  .object({
    rule: z.string().min(1),
    count: z.number().int().min(1),
  })
  .strict();

export const judgmentEgressStatusSchema = z.enum([
  "checked_no_findings",
  "checked_redacted",
  "error",
]);

export const judgmentAnswerValueSchema = z.union([z.string(), z.number(), z.null()]);

export const judgmentAnswerSchema = z
  .object({
    name: z.string().min(1),
    type: judgmentQuestionTypeSchema,
    value: judgmentAnswerValueSchema,
    probabilities: z.record(z.number()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
