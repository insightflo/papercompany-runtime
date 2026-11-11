// 429 (Z.AI code 1302) rate-limit backoff for the pi-local adapter.
//
// A single `pi --mode rpc` process burns through its internal retries in
// seconds when the shared Z.AI account hits its per-minute request limit
// (429: {"code":"1302","message":"Rate limit reached for requests"}), and
// every concurrently-running pi_local run repeats the pattern inside the same
// rate-limit window. This module provides:
//   - precise detection of the 429/1302 provider failure,
//   - provider `Retry-After` parsing (seconds, ms, HTTP-date, text hints),
//   - exponential backoff with positive jitter (Retry-After as a floor),
//   - a process-wide per-provider cooldown gate that staggers concurrent
//     runs — including heartbeat's 0ms transient requeues — so they restart
//     sequentially after the window reopens instead of as one herd.

const RETRY_AFTER_MAX_MS = 300_000;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 15_000;
const DEFAULT_MAX_DELAY_MS = 90_000;
const DEFAULT_JITTER_RATIO = 0.3;
const DEFAULT_STAGGER_MS = 2_000;

export type PiRateLimitEvidence = {
  /** Structured failure strings from parsePiJsonl (failed turns / exhausted retries). */
  readonly errors: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  /** Raw child exit code. Enables the conservative stderr/stdout fallback. */
  readonly exitCode?: number | null;
};

export type PiRateLimitBackoffConfig = {
  /** Adapter-level retries after the first attempt failed with 429/1302. */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Positive jitter ratio: adds 0..ratio of the floor delay. */
  readonly jitterRatio: number;
};

const CODE_1302_PATTERN = /"code"\s*:\s*"?1302"?/;
const RATE_LIMIT_429_THEN_1302_PATTERN = /\b429\b[^\r\n]{0,300}?\b1302\b/i;
const RATE_LIMIT_429_WORD_PATTERN = /\b429\b/i;
const RATE_LIMIT_TEXT_PATTERN = /(rate limit reached for requests|rate_limit|too many requests)/i;

function matchesRateLimit1302(text: string): boolean {
  return (
    CODE_1302_PATTERN.test(text) ||
    RATE_LIMIT_429_THEN_1302_PATTERN.test(text) ||
    (RATE_LIMIT_429_WORD_PATTERN.test(text) && RATE_LIMIT_TEXT_PATTERN.test(text))
  );
}

/**
 * Detect the provider 429 (code 1302) rate limit. Structured errors are
 * authoritative; raw stdout/stderr are only consulted for failed terminations
 * (exitCode != null && exitCode !== 0) so ordinary response text that merely
 * mentions "429" or "rate_limit" can never be misread as a provider failure.
 * The stdout fallback only trusts JSON error events (`type:"error"` or
 * `auto_retry_end` with success !== true), never free-form text.
 */
export function detectPiRateLimit1302(evidence: PiRateLimitEvidence): boolean {
  for (const error of evidence.errors) {
    if (matchesRateLimit1302(error)) return true;
  }
  const failedTermination = evidence.exitCode != null && evidence.exitCode !== 0;
  if (!failedTermination) return false;
  for (const line of evidence.stderr.split(/\r?\n/)) {
    if (matchesRateLimit1302(line)) return true;
  }
  for (const rawLine of evidence.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; message?: unknown; success?: unknown; finalError?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "error" && matchesRateLimit1302(String(event.message ?? ""))) return true;
    if (
      event.type === "auto_retry_end" &&
      event.success !== true &&
      matchesRateLimit1302(String(event.finalError ?? ""))
    ) {
      return true;
    }
  }
  return false;
}

function clampRetryAfterMs(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  const rounded = Math.round(ms);
  if (rounded <= 0) return null;
  // Never discard a positive, finite hint: oversized provider values (e.g.
  // `Retry-After: 600` seconds) are clamped to the 5-minute ceiling so they
  // still arm a usable cooldown instead of silently meaning "no hint".
  return Math.min(RETRY_AFTER_MAX_MS, rounded);
}

function parseRetryAfterMsFromText(text: string, nowMs: number): number | null {
  if (!text) return null;

  const msField = text.match(/"(?:retry_after_ms|retryAfterMs)"\s*:\s*"?(\d+(?:\.\d+)?)"?/i);
  if (msField) return clampRetryAfterMs(Number(msField[1]));

  const header = text.match(/\bretry-after\b\s*:\s*"?([^\n"{}]+)"?[ \t]*$/im);
  if (header) {
    const value = header[1].trim();
    const asNumber = Number(value);
    if (value.length > 0 && /^-?\d+(\.\d+)?$/.test(value)) {
      // HTTP `Retry-After: <number>` is always seconds.
      return clampRetryAfterMs(asNumber * 1000);
    }
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return clampRetryAfterMs(parsedDate - nowMs);
  }

  // `retry_after` / `retryAfter` fields are seconds, unlike the explicit
  // `_ms` fields handled above.
  const secondsField = text.match(/"(?:retry_after|retryAfter)"\s*:\s*"?(\d+(?:\.\d+)?)"?/i);
  if (secondsField) return clampRetryAfterMs(Number(secondsField[1]) * 1000);

  // Explicit `ms` suffix carries milliseconds; a bare `s` suffix is seconds.
  const msHint = text.match(/\b(?:try again in|retry after|retrying in)\s+(\d+(?:\.\d+)?)\s*ms\b/i);
  if (msHint) return clampRetryAfterMs(Number(msHint[1]));

  const humanHint = text.match(/\b(?:try again in|retry after|retrying in)\s+(\d+(?:\.\d+)?)\s*s\b/i);
  if (humanHint) return clampRetryAfterMs(Number(humanHint[1]) * 1000);

  return null;
}

/**
 * Extract a provider `Retry-After` hint, preferring structured errors, then
 * stderr, then stdout. Positive finite hints are clamped into (0, 300_000] ms;
 * null only when no usable hint exists.
 */
export function parseRetryAfterMs(
  evidence: PiRateLimitEvidence,
  nowMs: number = Date.now(),
): number | null {
  const sources = [...evidence.errors, evidence.stderr, evidence.stdout];
  for (const source of sources) {
    const ms = parseRetryAfterMsFromText(source, nowMs);
    if (ms !== null) return ms;
  }
  return null;
}

function clampIntFromEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumberFromEnv(raw: string | undefined, fallback: number, min: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

/** Backoff knobs from the environment (see PAPERCLIP_PI_429_* variables). */
export function resolvePiRateLimitBackoffConfig(
  env: Record<string, string | undefined> = process.env,
): PiRateLimitBackoffConfig {
  return {
    maxRetries: clampIntFromEnv(env.PAPERCLIP_PI_429_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 5),
    baseDelayMs: clampNumberFromEnv(env.PAPERCLIP_PI_429_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS, 0),
    maxDelayMs: clampNumberFromEnv(env.PAPERCLIP_PI_429_MAX_DELAY_MS, DEFAULT_MAX_DELAY_MS, 1),
    jitterRatio: DEFAULT_JITTER_RATIO,
  };
}

/**
 * Exponential backoff with positive jitter. The provider `Retry-After` (when
 * present) is a floor: we always wait at least as long as the provider asked.
 */
export function computeRateLimitBackoffMs(
  attemptIndex: number,
  retryAfterMs: number | null,
  config: PiRateLimitBackoffConfig = resolvePiRateLimitBackoffConfig(),
  random: () => number = Math.random,
): number {
  const expDelayMs = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attemptIndex));
  const floorDelayMs =
    retryAfterMs != null ? Math.min(RETRY_AFTER_MAX_MS, Math.max(expDelayMs, retryAfterMs)) : expDelayMs;
  const jitterMs = Math.round(floorDelayMs * config.jitterRatio * random());
  return Math.round(floorDelayMs) + jitterMs;
}

// ---------------------------------------------------------------------------
// Process-wide shared provider cooldown gate.
// ---------------------------------------------------------------------------

type ProviderRateLimitGateState = {
  cooldownUntilMs: number;
  nextSlotAtMs: number;
};

const providerRateLimitGates = new Map<string, ProviderRateLimitGateState>();

/** Shared bucket per provider+biller (e.g. every `zai/glm-*` run). */
export function buildRateLimitGateKey(biller: string | null, provider: string | null): string {
  return `pi-local:${biller ?? "unknown"}:${provider ?? "unknown"}`;
}

function resolveStaggerGapMs(env: Record<string, string | undefined> = process.env): number {
  if (typeof env.PAPERCLIP_PI_429_STAGGER_MS !== "string") return DEFAULT_STAGGER_MS;
  const parsed = Number(env.PAPERCLIP_PI_429_STAGGER_MS.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STAGGER_MS;
  return parsed;
}

/**
 * Arm the shared cooldown. Called whenever a run observes 429/1302 — even if
 * that run will not retry itself — so the next run to enter this process
 * (including a heartbeat transient requeue) waits out the window first.
 */
export function recordProviderRateLimitCooldown(
  gateKey: string,
  delayMs: number,
  nowMs: number = Date.now(),
): void {
  const now = Math.round(nowMs);
  const state = providerRateLimitGates.get(gateKey) ?? { cooldownUntilMs: 0, nextSlotAtMs: 0 };
  const cooldownUntilMs = Math.max(state.cooldownUntilMs, now + Math.max(0, Math.round(delayMs)));
  state.cooldownUntilMs = cooldownUntilMs;
  // Keep already-reserved stagger slots behind the (possibly extended) cooldown
  // so later reservations queue after the window reopens.
  state.nextSlotAtMs = Math.max(state.nextSlotAtMs, cooldownUntilMs);
  providerRateLimitGates.set(gateKey, state);
}

/**
 * Reserve the next departure slot on a gate. Returns the ms this run must wait
 * before touching the provider. Concurrent callers are staggered by
 * staggerGap (+0..15% jitter) past the cooldown so a herd of waiting runs —
 * or a 0ms heartbeat requeue — restarts sequentially, not simultaneously.
 * A free gate (no active cooldown, empty queue) returns waitMs 0 untouched.
 */
export function reserveProviderRateLimitSlot(
  gateKey: string,
  nowMs: number = Date.now(),
): { waitMs: number } {
  const now = Math.round(nowMs);
  const state = providerRateLimitGates.get(gateKey);
  if (!state) return { waitMs: 0 };
  const startAtMs = Math.max(state.cooldownUntilMs, state.nextSlotAtMs, now);
  if (startAtMs <= now) return { waitMs: 0 };
  const staggerMs = resolveStaggerGapMs();
  const jitterMs = Math.round(staggerMs * 0.15 * Math.random());
  state.nextSlotAtMs = startAtMs + staggerMs + jitterMs;
  return { waitMs: startAtMs - now };
}

/** Test isolation: clears every shared cooldown gate. */
export function resetPiRateLimitGateForTests(): void {
  providerRateLimitGates.clear();
}
