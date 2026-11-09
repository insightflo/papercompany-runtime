export function resolveHeartbeatFailureCode(error: unknown, fallback: string) {
  if (typeof (error as { code?: unknown } | null)?.code === "string") {
    return (error as { code: string }).code;
  }
  return fallback;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

// 보존 절단 정리(heartbeat-run-output-retention.ts)가 SQL IN 절을 이 값과
// 단일 소스로 유지하기 위해 배열 형태로도 공개한다.
export const TERMINAL_HEARTBEAT_RUN_STATUS_VALUES = [...TERMINAL_HEARTBEAT_RUN_STATUSES] as const;

export function isTerminalHeartbeatRunStatus(status: string | null | undefined) {
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status ?? "");
}

export function isSucceededHeartbeatRunStatus(status: string | null | undefined): status is "succeeded" {
  return status === "succeeded";
}
