export function resolveHeartbeatFailureCode(error: unknown, fallback: string) {
  if (typeof (error as { code?: unknown } | null)?.code === "string") {
    return (error as { code: string }).code;
  }
  return fallback;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function isTerminalHeartbeatRunStatus(status: string | null | undefined) {
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status ?? "");
}
