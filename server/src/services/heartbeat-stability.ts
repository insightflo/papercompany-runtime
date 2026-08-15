// [run stability] 하트비트 실행 안정성 노브 — 증거 기반 임계값.
//   근거(2026-08-15 GAZ/RES 실측):
//   - 성공 run 로그 ≤2.6MB vs 실패 run 8~11.4MB → 폭주 가드 상한 5MB(2× 여유).
//   - adapter_failed 19건 평균 107초 → 일시 오류 1회 자동 재시도의 transients 판정 상한 300초.
//   - 900s 실행 부실 리퍼가 15분+ 검수 run을 죽임(08-11 사례) → QA/검수 step 기본 1800초.

import { isQaLikeStep } from "./workflow-step-role.js";

export const DEFAULT_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_RUNAWAY_LOG_LIMIT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC = 300;

function readPositiveIntEnv(value: string | undefined): number | null {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** QA/검수 step의 실행 부실 타임아웃(기본 1800초). 0으로 설정하면 비활성화. */
export function resolveQaStepActiveExecutionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS ?? "").trim();
  if (raw === "0") return 0;
  const parsed = readPositiveIntEnv(raw);
  return parsed === null ? DEFAULT_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS : parsed * 1000;
}

/** run 로그 폭주 상한 바이트. agent adapterConfig.runawayLogLimitBytes > env > 기본 5MB. 0=비활성화. */
export function resolveRunawayLogLimitBytes(
  adapterConfig: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = adapterConfig?.runawayLogLimitBytes;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  const raw = (env.PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES ?? "").trim();
  if (raw === "0") return 0;
  const parsed = readPositiveIntEnv(raw);
  return parsed === null ? DEFAULT_RUNAWAY_LOG_LIMIT_BYTES : parsed;
}

/** adapter_failed를 일시 오류로 보고 1회 재시도하는 최대 실행 시간(초). 0=비활성화. */
export function resolveAdapterFailedTransientRetryMaxSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC ?? "").trim();
  if (raw === "0") return 0;
  const parsed = readPositiveIntEnv(raw);
  return parsed === null ? DEFAULT_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC : parsed;
}

export type StepTimeoutContract = {
  stepTimeoutSeconds?: number | null;
  isQaStep?: boolean | null;
} | null | undefined;

/**
 * 실행 부실(active execution) 타임아웃의 step 등급 반영:
 *   1) step이 명시적 timeoutSeconds를 가지면 max(base, timeoutSeconds)
 *   2) QA/검수 step이면 max(base, qaStepActiveExecutionTimeoutMs)
 *   3) 그 외 base 유지 (낮추지 않는다)
 */
export function resolveStepAwareActiveExecutionTimeoutMs(input: {
  baseMs: number;
  contract: StepTimeoutContract;
  qaStepActiveExecutionTimeoutMs: number;
}): number {
  const { baseMs, contract } = input;
  if (baseMs <= 0) return 0;
  if (!contract) return baseMs;
  const stepTimeoutSeconds =
    typeof contract.stepTimeoutSeconds === "number" && Number.isFinite(contract.stepTimeoutSeconds)
      ? Math.floor(contract.stepTimeoutSeconds)
      : 0;
  if (stepTimeoutSeconds > 0) {
    return Math.max(baseMs, stepTimeoutSeconds * 1000);
  }
  if (contract.isQaStep === true && input.qaStepActiveExecutionTimeoutMs > 0) {
    return Math.max(baseMs, input.qaStepActiveExecutionTimeoutMs);
  }
  return baseMs;
}

/** workflow step 정규화 결과에서 step 등급 신호를 뽑는 헬퍼 (contract 조립용). */
export function stepTimeoutSignalsFromStep(step: {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  type?: unknown;
  qaType?: unknown;
  timeoutSeconds?: unknown;
}): { stepTimeoutSeconds: number; isQaStep: boolean } {
  const timeoutSeconds =
    typeof step.timeoutSeconds === "number" && Number.isFinite(step.timeoutSeconds)
      ? Math.max(0, Math.floor(step.timeoutSeconds))
      : 0;
  return {
    stepTimeoutSeconds: timeoutSeconds,
    isQaStep: isQaLikeStep(step),
  };
}
