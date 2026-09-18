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

/**
 * 질문 criteria — TypeSafe SDK(공식) 계약을 반영해 3가지 형태를 지원한다.
 * - string: 자유 서술(레거시 B-1 형태). choice/score 에 쓰면 SDK 가 서버 계약
 *   위반으로 거부할 수 있다(선택지/루브릭 정의가 없으므로).
 * - Record<string, string|null>: choice 선택지({라벨: 설명}) 또는 noul({true,false}).
 * - Array<string|null>: score 루브릭(0부터 순서대로, 최소 2개).
 */
export type JudgmentQuestionCriteria =
  | string
  | Record<string, string | null>
  | Array<string | null>;

export interface JudgmentQuestion {
  /** 질문 식별자. answers 매핑의 키로 쓰인다. */
  name: string;
  type: JudgmentQuestionType;
  instructions: string;
  criteria?: JudgmentQuestionCriteria;
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
  /**
   * 질문 묶음의 단일 데이터 정책 목적(예: "plan-qa-prescreen-observation").
   * 하나의 정의 = 하나의 purpose — 묶음 안 개별 질문마다 다른 정책을 걸 수 없다
   * (모든 질문이 같은 state 를 보므로 데이터 반출 정책도 묶음 단위로만 성립).
   */
  purpose?: string;
  /**
   * 정의(질문 묶음)의 출처 등급. "secret" 정의는 호출 자체가 차단된다.
   * 기존 정의 하위호환: 생략 시 미분류(internal 취급, 반출 검사는 계속 적용).
   */
  originClass?: JudgmentDefinitionOriginClass;
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

/** 정의/필드의 출처 등급. "secret" 은 외부 판단 공급자 반출 금지. */
export type JudgmentDefinitionOriginClass = "internal" | "public" | "secret";

/**
 * judgment_calls.outcome 값. 현재 생성 경로는 'observed' 뿐이다.
 * - 'blocked' 는 반출 통제(egress) 거부: 재시도 대상이 아니며, 원문을 큰 모델 등
 *   다른 공급자로 폴백 전송하는 것도 금지다(폴백 공급자도 같은 데이터 정책을
 *   충족해야 하므로 원문 폴백은 정책 위반이다).
 */
export type JudgmentCallOutcome =
  | "executed"
  | "observed"
  | "error"
  | "disabled"
  | "blocked";

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

// ---------------------------------------------------------------------------
// 반출 통제(egress) — 트랙 C0. 판단 state 의 최소 데이터 반출 계약.
// ---------------------------------------------------------------------------

/** 규칙 기반 탐지 결과. matched text 는 저장하지 않는다(원본 유출 방지). */
export interface JudgmentEgressFinding {
  /** 탐지 규칙 식별자(예: "korean_rrn"). */
  rule: string;
  /** 해당 규칙으로 치환한 발생 수. */
  count: number;
}

/**
 * 반출 검사 상태.
 * - checked_no_findings: 검사 완료, 탐지 0건(미탐지≠안전이지만 규칙상 깨끗).
 * - checked_redacted: 검사 완료, 탐지 규칙이 PII/비밀 패턴을 치환했다.
 * - error: 검사 자체 실패(직렬화 불가 등) — 통과가 아니다. 전송 금지.
 */
export type JudgmentEgressStatus = "checked_no_findings" | "checked_redacted" | "error";
