/**
 * 판단 계층 서비스 — 정의 조회 + 공급자 호출 + 감사행 기록 (트랙 B-1).
 *
 * 원칙: "모델은 추천하고, 정책은 허용하며, 검증기는 완료를 확인한다."
 * askJudgment 의 결과는 실행 권한이 아니라 권고다(mode 기본 'observed').
 *
 * - 활성 정의 조회: (companyId, name, isActive) 중 version 이 가장 높은 것.
 *   정의가 없으면 error 결과를 반환한다. 이때 감사행을 남기지 않는데,
 *   judgment_calls.definitionId 가 NOT NULL FK 라서 참조할 정의가 없으면 행을
 *   만들 수 없기 때문이다(스키마 주석 참조).
 * - 감사: 성공/실패/비활성 무관 호출 1건당 judgment_calls 1행. 실제 보낸
 *   state/questions, 받은 answers, 시도 횟수, 지연시간, 토큰 사용량, 비용,
 *   모델 버전, 정의 버전 스냅샷을 남겨 "왜 시스템이 그 답을 실행에 사용했는가"를
 *   재구성할 수 있게 한다.
 * - 재시도 단일 소유권: provider 가 재시도를 소유한다. 서비스는 재시도하지 않고
 *   provider 결과의 attempts 를 그대로 감사행에 기록한다.
 * - env 게이트(PAPERCLIP_JUDGMENT_ENABLED)는 provider 가 판정한다.
 * - 실행제어 경로(하트비트/워크플로우/PLAN-QA) 연동은 B-2 이후. 이 모듈은
 *   서비스 export 만 제공하고 라우트를 만들지 않는다.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { judgmentCalls, judgmentDefinitions } from "@paperclipai/db";
import type {
  JudgmentAnswer,
  JudgmentAskState,
  JudgmentQuestion,
} from "@paperclipai/shared";
import { createTypesafeProvider, type JudgmentProvider } from "./provider.js";

/**
 * 공급자별 단가 테이블 (USD / 1M 토큰).
 * B-1 은 typesafe 1개만 하드코딩한다. 모르는 공급자는 비용을 추측하지 않고 null.
 */
export const JUDGMENT_PROVIDER_PRICING: Readonly<
  Record<string, { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }>
> = {
  typesafe: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 },
};

export function computeJudgmentCostUsd(
  providerId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!providerId) return null;
  const pricing = JUDGMENT_PROVIDER_PRICING[providerId];
  if (!pricing) return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}

export interface JudgmentServiceDeps {
  /** 기본: env 를 읽는 typesafe provider. 테스트는 목 provider 를 주입한다. */
  provider?: JudgmentProvider;
}

export interface AskJudgmentInput {
  companyId: string;
  definitionName: string;
  contextType: string;
  contextId: string;
  state: JudgmentAskState;
  /** 질문 name → 부분 덮어쓰기(instructions/criteria). */
  questionOverrides?: Partial<Pick<JudgmentQuestion, "instructions" | "criteria">> & {
    [questionName: string]: Partial<Pick<JudgmentQuestion, "instructions" | "criteria">> | undefined;
  };
  /** 판단이 실행에 직접 반영되는지. B-1 읔 'observed'(관측 전용)만 지원. */
  mode?: "observed";
}

export interface AskJudgmentResult {
  status: "observed" | "error" | "disabled";
  answers?: JudgmentAnswer[];
  /** answers 중 정의된 confidence 의 최솟값 (없으면 undefined). */
  confidence?: number;
  /** judgment_calls 행 id. 활성 정의가 없어 기록하지 못했으면 null. */
  auditId: string | null;
  error?: string;
  message?: string;
  modelVersion?: string;
  attempts: number;
  latencyMs?: number;
}

function assembleQuestions(
  base: JudgmentQuestion[],
  overrides: AskJudgmentInput["questionOverrides"],
): JudgmentQuestion[] {
  if (!overrides) return base;
  return base.map((question) => {
    const override = overrides[question.name];
    if (!override) return question;
    return { ...question, ...override };
  });
}

function lowestConfidence(answers: JudgmentAnswer[]): number | undefined {
  const values = answers
    .map((answer) => answer.confidence)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

export interface JudgmentService {
  askJudgment(input: AskJudgmentInput): Promise<AskJudgmentResult>;
}

export function createJudgmentService(db: Db, deps: JudgmentServiceDeps = {}): JudgmentService {
  const provider = deps.provider ?? createTypesafeProvider();

  return {
    async askJudgment(input: AskJudgmentInput): Promise<AskJudgmentResult> {
      const [definition] = await db
        .select()
        .from(judgmentDefinitions)
        .where(
          and(
            eq(judgmentDefinitions.companyId, input.companyId),
            eq(judgmentDefinitions.name, input.definitionName),
            eq(judgmentDefinitions.isActive, true),
          ),
        )
        .orderBy(desc(judgmentDefinitions.version))
        .limit(1);

      if (!definition) {
        return {
          status: "error",
          auditId: null,
          error: "no_active_definition",
          message: `no active judgment definition '${input.definitionName}' for company ${input.companyId}`,
          attempts: 0,
        };
      }

      const questions = assembleQuestions(
        definition.definition.questions,
        input.questionOverrides,
      );
      const mode = input.mode ?? "observed";

      const result = await provider.ask({
        state: input.state,
        model: definition.modelId,
        questions,
      });

      const succeeded = result.status === "ok";
      const costUsd = succeeded
        ? computeJudgmentCostUsd(definition.providerId, result.usage.inputTokens, result.usage.outputTokens)
        : null;

      const [row] = await db
        .insert(judgmentCalls)
        .values({
          companyId: input.companyId,
          definitionId: definition.id,
          definitionVersion: definition.version,
          contextType: input.contextType,
          contextId: input.contextId,
          correlationKey: `${input.contextType}:${input.contextId}`,
          inputState: input.state,
          questions,
          answers: succeeded ? result.answers : null,
          outcome: succeeded ? mode : result.status,
          error: succeeded ? null : `${result.error}: ${result.message}`,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          inputTokens: succeeded ? result.usage.inputTokens : null,
          outputTokens: succeeded ? result.usage.outputTokens : null,
          costUsd: costUsd === null ? null : costUsd.toFixed(6),
          providerId: definition.providerId,
          modelVersion: succeeded ? result.modelVersion : null,
        })
        .returning({ id: judgmentCalls.id });

      return {
        status: succeeded ? mode : result.status,
        ...(succeeded ? { answers: result.answers } : {}),
        ...(succeeded ? { confidence: lowestConfidence(result.answers) } : {}),
        ...(succeeded ? { modelVersion: result.modelVersion } : {}),
        auditId: row.id,
        ...(succeeded ? {} : { error: result.error, message: result.message }),
        attempts: result.attempts,
        latencyMs: result.latencyMs,
      };
    },
  };
}
