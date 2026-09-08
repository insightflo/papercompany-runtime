/**
 * [파일 목적] mission-resume 런타임 Task5b 순수 헬퍼의 입력/출력 계약 타입.
 *   런타임 import 가 없다 — 구조적 타입만 정의하며, 소비자(read-model, 이후 Task5b2/5c)가
 *   durable record 로부터 조립해 넘긴다. 여기서 status/flag 를 추론하지 않는다.
 * [수정시 주의]
 *   - hasOwner 는 "현재 미해결 소유권"만 의미한다(status 추론 아님).
 *   - hasAttempt / hasQueue / hasExternalResult 는 "현재 실행 중"이 아니라
 *     "기록된 이력 전부"를 의미한다.
 *   - 필드 추가/변경은 graph.ts / eligibility.ts 와 Task5b2/5c 소비자 설계와 함께 검토할 것.
 */

/** canonical 정의로부터 조립된 워크플로 그래프 노드(이미 canonical — 정규화 없음). */
export interface ResumeNode {
  id: string;
  dependencies: string[];
  conditionalDependencies: { stepId: string }[];
}

/** step 1개의 기록 실행 이력 스냅샷. 호출자가 canonical 정의 + 검토된 registry 근거로 확정한다. */
export interface StepHistory {
  stepId: string;
  status: string;
  issueId: string | null;
  startedAt: string | null;
  executionGeneration: number;
  hasAttempt: boolean;
  hasQueue: boolean;
  hasOwner: boolean;
  hasExternalResult: boolean;
  effect: "none" | "read_only" | "external" | "unknown";
  kind: "agent" | "tool" | "control";
}

/** checkStepEligibility 가 반환하는 차단 사유. null 은 per-step 적격(resumability 인증 아님). */
export type StepEligibilityBlocker =
  | "unsupported_status"
  | "active_work"
  | "executed_step"
  | "external_effect_unknown"
  | "control_tool_effects_unverified";
