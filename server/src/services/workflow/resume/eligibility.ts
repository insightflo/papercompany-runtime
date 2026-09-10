/**
 * [파일 목적] step 단위 resume 적격성 판정 순수 함수. 단일 StepHistory 만 입력으로 받아
 *   StepEligibilityBlocker | null 을 반환한다(다른 step/전역 상태/시계/DB 참조 없음).
 * [주요 흐름] 규칙 순서 고정:
 *   1) running→active_work, completed→executed_step, pending/failed/skipped 이외→
 *      unsupported_status(cancelled/canceled/unknown 포함).
 *   2) hasOwner→active_work(모든 kind, 겉보기 미실행이어도).
 *   3) agent/tool: issueId|startedAt|hasAttempt|hasQueue|hasExternalResult 중 하나라도
 *      기록되면 executed_step — 미발화처럼 보이는 status 가 이력을 가리는 것을 막는다.
 *      executionGeneration 단독은 이력이 아니다. 이력이 없으면 effect unknown→
 *      external_effect_unknown, 알려진 effect(external 포함)는 미래 미실행으로 허용.
 *   4) control: issueId|hasExternalResult→executed_step. effect external/unknown→
 *      control_tool_effects_unverified(none/read_only 만 허용). pending 인데
 *      startedAt/hasAttempt/hasQueue 잔존→executed_step(불일치 미종료 과거).
 *      failed/skipped 의 잔존 흔적(active owner·issue·외부결과 없음)은 통제된 재평가로 허용
 *      — agent/tool 재실행이 아니다.
 * [수정시 주의]
 *   - null 은 오직 per-step 적격이다. resumability 인증이 아니며, scope/status·registry 근거·
 *     outside predecessors·required gates·budget/publication 등 나머지 정책은 이후
 *     Task5b2/5c 호출자가 책임진다. 이 함수 단독으로 resumability 를 주장하지 않는다.
 *   - 시계/registry 조회/토큰/자연어 해석/DB/파일시스템/도구명 allowlist 금지.
 *   - kind/effect 는 호출자가 canonical 정의 + 검토된 registry 버전/설정으로 확정해 넘겨야
 *     하며 client flag 를 신뢰하지 않는다. 동적 입력 schema 를 여기서 발명하지 않는다.
 */

import type { StepEligibilityBlocker, StepHistory } from "./types.js";

const RESUMABLE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["pending", "failed", "skipped"]);

export function checkStepEligibility(history: StepHistory): StepEligibilityBlocker | null {
  if (history.status === "running") return "active_work";
  if (history.status === "completed") return "executed_step";
  if (!RESUMABLE_TERMINAL_STATUSES.has(history.status)) return "unsupported_status";
  if (history.hasOwner) return "active_work";

  if (history.kind === "agent" || history.kind === "tool") {
    if (
      history.issueId !== null ||
      history.startedAt !== null ||
      history.hasAttempt ||
      history.hasQueue ||
      history.hasExternalResult
    ) {
      return "executed_step";
    }
    if (history.effect === "unknown") return "external_effect_unknown";
    return null;
  }

  // kind === "control"
  if (history.issueId !== null || history.hasExternalResult) return "executed_step";
  if (history.effect === "external" || history.effect === "unknown") {
    return "control_tool_effects_unverified";
  }
  if (history.status === "pending") {
    if (history.startedAt !== null || history.hasAttempt || history.hasQueue) {
      return "executed_step";
    }
  }
  return null;
}
