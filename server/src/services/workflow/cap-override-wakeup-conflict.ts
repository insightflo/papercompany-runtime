export const CAP_OVERRIDE_WAKE_KEY_PREFIX = "cap-override-wake:";
export const CAP_OVERRIDE_WAKE_UNIQUE_CONSTRAINT = "agent_wakeup_requests_cap_override_live_idempotency_uq";

export function isCapOverrideWakeKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CAP_OVERRIDE_WAKE_KEY_PREFIX);
}

export function isCapOverrideWakeUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (candidate.code === "23505" && constraint === CAP_OVERRIDE_WAKE_UNIQUE_CONSTRAINT) return true;
    current = candidate.cause;
  }
  return false;
}
