// server/src/services/workflow/retry-metadata.ts
//
// Pure, database-free workflow step retry metadata construction and validation.

export type WorkflowRetryMetadataState = "waiting" | "dispatching";

export interface WorkflowRetryMetadata {
  state: WorkflowRetryMetadataState;
  retryNumber: number;
  maxRetries: number;
  nextEligibleAt: string;
  sourceRequestId: string | null;
  sourceCompletedAt: string | null;
  lastErrorSummary: string | null;
}

export interface WorkflowRetryAttemptSummary {
  retryNumber: number;
  failedAt: string | null;
  errorSummary: string | null;
}

const FAILURE_SUMMARY_MAX = 500;
const MAX_ATTEMPT_HISTORY = 20;

export function sanitizeErrorSummary(value: unknown): string | null {
  const raw = String(value ?? "");
  const trimmedStart = raw.trim();
  // Fail-closed for structured JSON/tool-payload strings — never copy raw
  // object fields that might contain credentials, tokens, or secrets.
  if (
    (trimmedStart.startsWith("{") && trimmedStart.endsWith("}"))
    || (trimmedStart.startsWith("[") && trimmedStart.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmedStart);
      return "[structured payload]";
    } catch {
      // Not valid JSON — fall through to pattern-based redaction.
    }
  }
  // Redact known sensitive patterns before any other processing.
  const redacted = raw
    .replace(/(?:authorization|auth|x-api-key|apikey|api-key)\s*[:=]\s*(?:bearer\s+|token\s+)?\S+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{20,}/gi, "[REDACTED]")
    .replace(/(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/(?:secret|token|access_key|accesskey|private_key)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/(["'](?:api_key|apikey|secret|token|password|private_key)["']\s*:\s*["'])[^"']*(["'])/gi, "$1[REDACTED]$2");
  const cleaned = redacted
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, FAILURE_SUMMARY_MAX) : null;
}

export function buildWorkflowRetryMetadata(input: {
  retryNumber: number;
  maxRetries: number;
  delaySeconds: number;
  now: Date;
  sourceRequestId: string | null;
  sourceCompletedAt: string | null;
  lastErrorSummary: string | null;
}): WorkflowRetryMetadata {
  const nextEligibleAt = new Date(input.now.getTime() + input.delaySeconds * 1000).toISOString();
  return {
    state: "waiting",
    retryNumber: input.retryNumber,
    maxRetries: input.maxRetries,
    nextEligibleAt,
    sourceRequestId: input.sourceRequestId,
    sourceCompletedAt: input.sourceCompletedAt,
    lastErrorSummary: sanitizeErrorSummary(input.lastErrorSummary),
  };
}

export function appendRetryAttempt(
  history: unknown,
  attempt: WorkflowRetryAttemptSummary,
): WorkflowRetryAttemptSummary[] {
  const arr = Array.isArray(history) ? (history as unknown[]) : [];
  // Normalize + sanitize every retained entry: drop malformed prior entries,
  // bound strings, and never carry raw payloads. Then cap to the latest N.
  const sanitized: WorkflowRetryAttemptSummary[] = [];
  for (const raw of arr) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") continue;
    const retryNumber = entry.retryNumber;
    if (typeof retryNumber !== "number" || !Number.isFinite(retryNumber) || !Number.isInteger(retryNumber) || retryNumber < 0) {
      continue;
    }
    sanitized.push({
      retryNumber,
      failedAt: boundedString(entry.failedAt),
      errorSummary: sanitizeErrorSummary(entry.errorSummary),
    });
  }
  // Append the new attempt only if it is valid; an invalid attempt is dropped
  // (fail closed) rather than persisted with a sentinel like -1.
  if (isFiniteNonNegInt(attempt.retryNumber)) {
    sanitized.push({
      retryNumber: attempt.retryNumber,
      failedAt: boundedString(attempt.failedAt),
      errorSummary: sanitizeErrorSummary(attempt.errorSummary),
    });
  }
  return sanitized.slice(-MAX_ATTEMPT_HISTORY);
}

export function isWorkflowRetryDue(metadata: unknown, now: Date): boolean {
  // Full validation via readWorkflowRetryMetadata: a malformed retryNumber/
  // maxRetries must never be launchable even when nextEligibleAt is due.
  const m = readWorkflowRetryMetadata(metadata);
  if (!m) return false;
  // `dispatching` is in-progress live work: it is NEVER re-dispatchable/due,
  // regardless of nextEligibleAt. Only a `waiting` retry becomes dispatchable
  // once its delay has elapsed (nextEligibleAt <= now).
  if (m.state !== "waiting") return false;
  return now.getTime() >= new Date(m.nextEligibleAt).getTime();
}

export function readWorkflowRetryMetadata(metadata: unknown): WorkflowRetryMetadata | null {
  const m = metadata as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const state = m.state;
  if (state !== "waiting" && state !== "dispatching") return null;
  const retryNumber = m.retryNumber;
  const maxRetries = m.maxRetries;
  // retryNumber must be a finite integer >= 1 (a real scheduled retry).
  if (!(typeof retryNumber === "number" && Number.isFinite(retryNumber) && Number.isInteger(retryNumber) && retryNumber >= 1)) {
    return null;
  }
  // maxRetries must be a finite non-negative integer and cover this retry.
  if (!isFiniteNonNegInt(maxRetries) || maxRetries < retryNumber) {
    return null;
  }
  const nextEligibleAt = m.nextEligibleAt;
  if (typeof nextEligibleAt !== "string") return null;
  const eligibleMs = new Date(nextEligibleAt).getTime();
  if (!Number.isFinite(eligibleMs)) return null;
  return {
    state,
    retryNumber,
    maxRetries,
    nextEligibleAt,
    sourceRequestId: boundedString(m.sourceRequestId),
    sourceCompletedAt: boundedString(m.sourceCompletedAt),
    lastErrorSummary: sanitizeErrorSummary(m.lastErrorSummary),
  };
}

const METADATA_STRING_MAX = 500;

/** Coerce a metadata string field to a bounded, sanitized string or null. */
function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, METADATA_STRING_MAX) : null;
}

function isFiniteNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * True when a step run carries a VALID workflow retry that is live automatic
 * continuation — `waiting` (future OR due) or `dispatching`. Such a step keeps
 * the workflow run running, suppresses terminal Human Operator reporting, and
 * protects the step from stuck-run skipping.
 *
 * MALFORMED workflowRetry metadata (key present but unreadable) is NOT live
 * work: the retry cannot launch, so the step must fall through to normal
 * terminal evaluation rather than being suppressed forever. Use
 * `hasMalformedWorkflowRetry` to detect that distinct case.
 *
 * `now` is accepted for API symmetry but does not gate liveness: a due retry
 * remains live until its next attempt actually completes.
 */
export function isStepRunAwaitingRetry(metadata: unknown, now: Date = new Date()): boolean {
  void now;
  const meta = metadata as Record<string, unknown> | null;
  if (!meta) return false;
  return readWorkflowRetryMetadata(meta.workflowRetry) !== null;
}

/**
 * True when a `workflowRetry` key is present but cannot be read as valid retry
 * metadata. The retry is unrecoverable: it must not launch and the step becomes
 * eligible for normal terminal evaluation.
 */
export function hasMalformedWorkflowRetry(metadata: unknown): boolean {
  const meta = metadata as Record<string, unknown> | null;
  if (!meta) return false;
  const raw = meta.workflowRetry;
  return raw !== undefined && raw !== null && readWorkflowRetryMetadata(raw) === null;
}
