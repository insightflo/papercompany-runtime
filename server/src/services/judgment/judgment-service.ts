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
 * - 집행점(트랙 C0): state 조립 직후 · provider 전송 직전에 반출 통제를 집행한다.
 *   우선순위: (1) 정의 originClass "secret" → blocked (2) state 의 secret 분류 필드 →
 *   blocked (3) redactForEgress 검사 실패 → error(전송 없음) (4) 그 외 → 검사본
 *   (redacted)을 provider 에 그대로 전송(전송되는 것 = 검사된 것, fixation)하고
 *   감사행 inputState 에도 검사본만 저장한다. 원본은 sha256 해시로만 추적한다.
 *   'blocked' 는 재시도 대상이 아니며 원문을 다른(더 큰) 모델로 폴백 전송하는 것도
 *   금지다 — 폴백 공급자도 같은 데이터 정책을 충족해야 하므로 원문 폴백은 정책 위반이다.
 * - 실행제어 경로(하트비트/워크플로우/PLAN-QA) 연동은 B-2 이후. 이 모듈은
 *   서비스 export 만 제공하고 라우트를 만들지 않는다.
 */

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { judgmentCalls, judgmentDefinitions } from "@paperclipai/db";
import type {
  JudgmentAnswer,
  JudgmentAskState,
  JudgmentEgressFinding,
  JudgmentEgressStatus,
  JudgmentQuestion,
} from "@paperclipai/shared";
import { createTypesafeProvider, type JudgmentProvider } from "./provider.js";
import { findSecretOriginPolicyFields, redactForEgress } from "./redact.js";
import { computeJudgmentCostUsd } from "./pricing.js";
import { resolveJudgmentModel, resolveJudgmentProviderConfig } from "./provider-config.js";

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
  /** 호출자가 정의의 질문 목록을 완전히 치환할 때 사용한다. 기존 호출부는 overrides를 유지한다. */
  questions?: JudgmentQuestion[];
  /** 질문 name → 부분 덮어쓰기(instructions/criteria). */
  questionOverrides?: Partial<Pick<JudgmentQuestion, "instructions" | "criteria">> & {
    [questionName: string]: Partial<Pick<JudgmentQuestion, "instructions" | "criteria">> | undefined;
  };
  /** 판단이 실행에 직접 반영되는지. B-1 읔 'observed'(관측 전용)만 지원. */
  mode?: "observed";
}

export interface AskJudgmentEgressInfo {
  /** 반출 검사 상태(checked_no_findings | checked_redacted | error). 미탐지≠안전. */
  status: JudgmentEgressStatus;
  /** 규칭명+횟수만(matched text 미노출). */
  findings: JudgmentEgressFinding[];
  /** sha256(원본 state 직렬화) — 원본은 저장/전송되지 않고 해시로만 대응 추적. */
  originalHash: string;
}

export interface AskJudgmentResult {
  /**
   * 'blocked' = 반출 통제 거부. 재시도 대상 아님, 원문 큰 모델 폴백 금지.
   */
  status: "observed" | "error" | "disabled" | "blocked";
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
  /**
   * 반출 통제 결과. 정의 조회에 실패해(no_active_definition) 검사가 시작되지 않은
   * 경로에는 없다.
   */
  egress?: AskJudgmentEgressInfo;
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

// ---------------------------------------------------------------------------
// 반출 통제(egress) 집행점 — 트랙 C0.
// "탐지기는 증거를 찾고, 정책은 반출을 허용하며, 집행점은 실제 전송을 통제한다."
// ---------------------------------------------------------------------------

/** 원본 state 직렬화 실패(순환 등) 시에도 결정적인 해시를 만들기 위한 폴백. */
function serializeStateForHash(state: unknown): string {
  try {
    const serialized = JSON.stringify(state);
    return serialized === undefined ? String(state) : serialized;
  } catch {
    return String(state);
  }
}

export function hashJudgmentState(state: unknown): string {
  return createHash("sha256").update(serializeStateForHash(state), "utf8").digest("hex");
}

/** redaction 실패 시 감사행 inputState 자리에 넣는 표식 — 원본은 절대 저장하지 않는다. */
const EGRESS_ERROR_PLACEHOLDER: JudgmentAskState = { egress_error: true };

export interface JudgmentService {
  askJudgment(input: AskJudgmentInput): Promise<AskJudgmentResult>;
}

export function createJudgmentService(db: Db, deps: JudgmentServiceDeps = {}): JudgmentService {
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

      const questions = input.questions ?? assembleQuestions(
        definition.definition.questions,
        input.questionOverrides,
      );
      const mode = input.mode ?? "observed";

      // --- 집행점: 전송 직전 반출 통제(순서 고정 — 감사행 우선순위와 일치) ---
      // 0) 항상: 원본 해시 + 규칙 검사를 먼저 돌린다(차단 행에도 검사 결과가 남게).
      const originalHash = hashJudgmentState(input.state);
      const egressScan = redactForEgress(input.state);
      const egress: AskJudgmentEgressInfo = {
        status: egressScan.status,
        findings: egressScan.findings,
        originalHash,
      };
      // 검사본 fixation: 전송본과 감사행 저장본이 같은 객체다(원본 아님).
      const auditedState: JudgmentAskState =
        egressScan.status === "error" ? EGRESS_ERROR_PLACEHOLDER : (egressScan.redacted as JudgmentAskState);

      // 1) 하드 거부: 정의가 "secret" 출처면 호출 자체를 차단한다.
      if (definition.definition.originClass === "secret") {
        const [row] = await db
          .insert(judgmentCalls)
          .values({
            companyId: input.companyId,
            definitionId: definition.id,
            definitionVersion: definition.version,
            contextType: input.contextType,
            contextId: input.contextId,
            correlationKey: `${input.contextType}:${input.contextId}`,
            inputState: auditedState,
            questions,
            outcome: "blocked",
            error: "blocked:definition_origin_class_secret",
            attempts: 0,
            providerId: definition.providerId,
            stateOriginalHash: originalHash,
            egressStatus: egressScan.status,
            egressFindings: egressScan.findings.length > 0 ? egressScan.findings : null,
          })
          .returning({ id: judgmentCalls.id });
        return {
          status: "blocked",
          auditId: row.id,
          error: "blocked:definition_origin_class_secret",
          message:
            "judgment definition is classified 'secret' — call blocked at egress enforcement point",
          attempts: 0,
          egress,
        };
      }

      // 2) 하드 거부: state 에 "secret" 분류 필드가 있으면 전송 금지.
      //    (blocked 는 재시도 대상 아님 — 원문 큰 모델 폴백 금지.)
      const secretFields = findSecretOriginPolicyFields(input.state);
      if (secretFields.length > 0) {
        const [row] = await db
          .insert(judgmentCalls)
          .values({
            companyId: input.companyId,
            definitionId: definition.id,
            definitionVersion: definition.version,
            contextType: input.contextType,
            contextId: input.contextId,
            correlationKey: `${input.contextType}:${input.contextId}`,
            inputState: auditedState,
            questions,
            outcome: "blocked",
            error: `blocked:state_field_origin_policy_secret:${secretFields.length}`,
            attempts: 0,
            providerId: definition.providerId,
            stateOriginalHash: originalHash,
            egressStatus: egressScan.status,
            egressFindings: egressScan.findings.length > 0 ? egressScan.findings : null,
          })
          .returning({ id: judgmentCalls.id });
        return {
          status: "blocked",
          auditId: row.id,
          error: `blocked:state_field_origin_policy_secret:${secretFields.length}`,
          message: `state contains ${secretFields.length} secret-classified field(s) — transmission blocked`,
          attempts: 0,
          egress,
        };
      }

      // 3) 검사 실패는 통과가 아니다 — 전송 없이 error 감사행.
      if (egressScan.status === "error") {
        const [row] = await db
          .insert(judgmentCalls)
          .values({
            companyId: input.companyId,
            definitionId: definition.id,
            definitionVersion: definition.version,
            contextType: input.contextType,
            contextId: input.contextId,
            correlationKey: `${input.contextType}:${input.contextId}`,
            inputState: auditedState,
            questions,
            outcome: "error",
            error: "egress_redaction_failed",
            attempts: 0,
            providerId: definition.providerId,
            stateOriginalHash: originalHash,
            egressStatus: egressScan.status,
          })
          .returning({ id: judgmentCalls.id });
        return {
          status: "error",
          auditId: row.id,
          error: "egress_redaction_failed",
          message: "redactForEgress could not produce a safe redacted copy — transmission refused",
          attempts: 0,
          egress,
        };
      }

      // 4) 전송: provider 는 검사본(redacted)을 그대로 받는다(전송=검사본 일치).
      //    주입 provider(테스트 목)는 인스턴스 설정을 읽지 않는다. 기본 provider 는
      //    호출마다 설정의 endpoint/model 오버라이드를 1회 읽어 반영한다.
      const config = deps.provider ? null : await resolveJudgmentProviderConfig(db);
      const provider =
        deps.provider ?? createTypesafeProvider(config?.baseUrl ? { baseUrl: config.baseUrl } : {});
      const result = await provider.ask({
        state: egressScan.redacted as JudgmentAskState,
        model: config ? resolveJudgmentModel(config, definition.modelId) : definition.modelId,
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
          inputState: auditedState,
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
          stateOriginalHash: originalHash,
          egressStatus: egressScan.status,
          egressFindings: egressScan.findings.length > 0 ? egressScan.findings : null,
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
        egress,
      };
    },
  };
}
