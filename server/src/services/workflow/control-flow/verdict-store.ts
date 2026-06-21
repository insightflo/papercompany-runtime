/**
 * [파일 목적] 워크플로 loop 의 각 iteration verdict/결함을 step_run.metadata.attempts[] 에 persist
 *   하는 순수 함수만 제공(DB/Date/부작용 없음). P4.
 *   기존 엔진에선 QA verdict 가 매 sync 마다 heartbeat/comment 로부터 재계산되어 step/issue 가
 *   리셋되면 함께 날아갔다. loop 가 "직전 iteration 에서 QA 가 뭘 지적했는지" 보게 하려면 verdict 를
 *   step_run.metadata(리셋에도 살아남음) 에 아카이브해야 한다. 이 모듈은 그 직렬화 보조만 담당한다.
 * [주요 흐름]
 *   1. readAttempts(metadata)   — metadata[controlFlowAttempts] 를 StepIterationAttempt[] 로 복원(검증).
 *   2. appendAttempt(metadata, attempt) — immutable append. 다른 metadata 키(executionControls 등) 보존.
 *   3. latestAttemptVerdict(metadata)   — 가장 마지막 attempt 의 verdict(없으면 null).
 * [외부 연결] consumer: step-reset.ts(리셋 시 attempt archive), loop-driver.ts(발화 판정 보조),
 *   dag-engine.ts buildPredFactsMap(선행 facts 의 verdict 를 persist 된 것으로 공급 — P4 정밀화).
 *   의존: types.ts(STEP_ITERATION_ATTEMPTS_KEY, StepIterationAttempt)만. 역참조/DB 없음.
 * [수정시 주의]
 *   - 순수해야 한다 — DB/now/부작용 금지. 호출자(dag-engine/step-reset)가 timestamp/iteration 를 채운
 *     StepIterationAttempt 를 넘긴다.
 *   - appendAttempt 는 기존 metadata 를 spread 보존한다(controlFlowSkipped sentinel 등도 그대로).
 *     sentinel 제거는 step-reset.ts 가 담당(관심사 분리).
 *   - 가즈아 25h hang 회귀 금지: 이 모듈 자체는 부작용이 없으므로 loop 안전성에 직접 관여하진 않는다.
 *     cap/종료는 loop-driver(maxIterations 게이트) 가 담당.
 */

import { STEP_ITERATION_ATTEMPTS_KEY, type StepIterationAttempt } from "./types.js";

/** metadata 가 객체가 아니면 빈 객체로 정규화(array/null/undefined 방어). */
function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** StepIterationAttempt 구조 검증 — iteration(number) + completedAt(string|null) 필수, 나머지 optional. */
function isStepIterationAttempt(value: unknown): value is StepIterationAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  if (typeof attempt.iteration !== "number" || !Number.isFinite(attempt.iteration)) return false;
  const completedAt = attempt.completedAt;
  if (completedAt !== null && typeof completedAt !== "string") return false;
  const verdict = attempt.verdict;
  if (verdict !== undefined && verdict !== null && verdict !== "pass" && verdict !== "request_changes") {
    return false;
  }
  if (attempt.failureReasons !== undefined && !Array.isArray(attempt.failureReasons)) return false;
  return true;
}

/**
 * [목적] metadata 에 저장된 attempts[] 복원(검증). 잘못된 원소는 drop.
 * [입력] step_run.metadata(jsonb; unknown). [출력] StepIterationAttempt[](빈 배열 가능).
 */
export function readAttempts(metadata: unknown): StepIterationAttempt[] {
  const raw = normalizeMetadata(metadata)[STEP_ITERATION_ATTEMPTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isStepIterationAttempt);
}

/**
 * [목적] metadata 에 attempt 를 immutable append 한 새 metadata 를 반환(원본 불변).
 *   기존 metadata 키(executionControls, controlFlowSkipped 등)는 그대로 보존한다.
 * [입력] metadata(unknown), attempt(StepIterationAttempt). [출력] 새 Record<string,unknown>.
 */
export function appendAttempt(
  metadata: unknown,
  attempt: StepIterationAttempt,
): Record<string, unknown> {
  const base = normalizeMetadata(metadata);
  const nextAttempts = [...readAttempts(base), attempt];
  return { ...base, [STEP_ITERATION_ATTEMPTS_KEY]: nextAttempts };
}

/**
 * [목적] 가장 최근 attempt 의 verdict. attempts[] 가 비었거나 verdict 미정이면 null.
 *   dag-engine buildPredFactsMap 이 qa_request_changes edge 평가를 정밀하게 하기 위해 사용(P4).
 */
export function latestAttemptVerdict(metadata: unknown): "pass" | "request_changes" | null {
  const attempts = readAttempts(metadata);
  if (attempts.length === 0) return null;
  return attempts[attempts.length - 1]!.verdict ?? null;
}
