/**
 * 판단 계층(judgment layer) 타입 — 트랙 B-1.
 *
 * 판단형 LLM(예: TypeSafe "System One"/jev)에 질문을 던져 권고를 받는 계약.
 * 원칙: "모델은 추천하고, 정책은 허용하며, 검증기는 완료를 확인한다."
 * 판단 결과는 실행 권한이 아니라 권고다(outcome 'observed' 기본).
 *
 * - DB 테이블 judgment_definitions.definition / judgment_calls 의 jsonb 구조와 1:1.
 * - 모델 버전은 고정 버전 ID(예: "jev-1.13.0")만 쓴다. 별칭(jev-latest) 금지.
 */

export type JudgmentQuestionType = "choice" | "score" | "noul";

export interface JudgmentQuestion {
  /** 질문 식별자. answers 매핑의 키로 쓰인다. */
  name: string;
  type: JudgmentQuestionType;
  instructions: string;
  criteria?: string;
}

/** choice → 옵션 문자열, score → 숫자, noul → null(답 없음). */
export type JudgmentAnswerValue = string | number | null;

export interface JudgmentAnswer {
  name: string;
  type: JudgmentQuestionType;
  value: JudgmentAnswerValue;
  /** 옵션별 확률(choice). 키=옵션, 값=확률. */
  probabilities?: Record<string, number>;
  /** 0~1 사이 모델 자기 신뢰도. */
  confidence?: number;
}

/** judgment_definitions.definition jsonb 구조 (버전이 스냅샷으로 보존된다). */
export interface JudgmentDefinitionSnapshot {
  description: string;
  stateAssembly: {
    kind: "inline-ref";
    notes: string;
  };
  questions: JudgmentQuestion[];
  policy: {
    notes: string;
    thresholds: Record<string, number>;
  };
}

/** judgment_calls.outcome 값. 현재 생성 경로는 'observed' 뿐이다. */
export type JudgmentCallOutcome = "executed" | "observed" | "error" | "disabled";

/** state는 문자열 / JSON 객체 / 텍스트 전용 배열만 허용. */
export type JudgmentAskState = string | Record<string, unknown> | string[];

export interface JudgmentAskInput {
  state: JudgmentAskState;
  /** 고정 모델 버전 ID. */
  model: string;
  questions: JudgmentQuestion[];
}

export interface JudgmentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JudgmentAskSuccess {
  status: "ok";
  answers: JudgmentAnswer[];
  /** 응답이 실제로 보고한 모델 버전(감사용). */
  modelVersion: string;
  usage: JudgmentUsage;
  attempts: number;
  latencyMs: number;
}

export type JudgmentErrorCode =
  | "gate_disabled"
  | "missing_api_key"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "http_error"
  | "invalid_response";

export interface JudgmentAskFailure {
  status: "disabled" | "error";
  error: JudgmentErrorCode;
  message: string;
  attempts: number;
  latencyMs: number;
}

export type JudgmentAskResult = JudgmentAskSuccess | JudgmentAskFailure;
