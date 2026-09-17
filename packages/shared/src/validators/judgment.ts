import { z } from "zod";

/**
 * 판단 계층 검증 (트랙 B-1).
 *
 * - 질문 type 은 'choice' | 'score' | 'noul' 만 허용 (text + 검증).
 * - judgmentDefinitionSnapshotSchema 는 judgment_definitions.definition jsonb 의
 *   구조 계약이다. 정의 저장/수정 경로(B-2 라우트)가 이 스키마로 거절한다.
 * - outcome 은 'executed' | 'observed' | 'error' | 'disabled'.
 */

export const judgmentQuestionTypeSchema = z.enum(["choice", "score", "noul"]);

export const judgmentQuestionSchema = z
  .object({
    name: z.string().min(1),
    type: judgmentQuestionTypeSchema,
    instructions: z.string().min(1),
    criteria: z.string().optional(),
  })
  .strict();

export const judgmentDefinitionSnapshotSchema = z
  .object({
    description: z.string().min(1),
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

export const judgmentCallOutcomeSchema = z.enum(["executed", "observed", "error", "disabled"]);

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
