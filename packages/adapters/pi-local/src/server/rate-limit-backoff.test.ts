import { describe, expect, it } from "vitest";
import {
  buildRateLimitGateKey,
  computeRateLimitBackoffMs,
  detectPiRateLimit1302,
  parseRetryAfterMs,
  recordProviderRateLimitCooldown,
  resetPiRateLimitGateForTests,
  reserveProviderRateLimitSlot,
  resolvePiRateLimitBackoffConfig,
} from "./rate-limit-backoff.js";

const A1_RATE_LIMIT_ERROR = `429: {"code":"1302","message":"Rate limit reached for requests"}`;

describe("detectPiRateLimit1302", () => {
  it("detects the exact A1 Z.AI 429-1302 failure string from structured errors", () => {
    expect(detectPiRateLimit1302({ errors: [A1_RATE_LIMIT_ERROR], stdout: "", stderr: "" })).toBe(true);
  });

  it("detects 429 combined with rate-limit wording or a trailing 1302 code", () => {
    expect(detectPiRateLimit1302({ errors: ["HTTP 429 Too Many Requests"], stdout: "", stderr: "" })).toBe(true);
    expect(
      detectPiRateLimit1302({ errors: ["request failed with 429, provider code 1302"], stdout: "", stderr: "" }),
    ).toBe(true);
    expect(
      detectPiRateLimit1302({ errors: ['{"code":1302,"message":"Rate limit reached for requests"}'], stdout: "", stderr: "" }),
    ).toBe(true);
  });

  it("does not flag ordinary errors without rate-limit evidence", () => {
    expect(detectPiRateLimit1302({ errors: ["connection reset by peer"], stdout: "", stderr: "" })).toBe(false);
    expect(detectPiRateLimit1302({ errors: ["exit code 1302 from helper script"], stdout: "", stderr: "" })).toBe(false);
  });

  it("does not flag normal assistant output that merely mentions 429 or rate_limit", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "PR #429 fixed the rate_limit docs and issue 429" },
      }),
      JSON.stringify({ type: "agent_end", willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n");
    expect(detectPiRateLimit1302({ errors: [], stdout, stderr: "", exitCode: 0 })).toBe(false);
  });

  it("falls back to stderr only for failed terminations", () => {
    expect(
      detectPiRateLimit1302({ errors: [], stdout: "", stderr: A1_RATE_LIMIT_ERROR, exitCode: 1 }),
    ).toBe(true);
    // Same stderr content on a successful exit must not be flagged from the fallback path.
    expect(
      detectPiRateLimit1302({ errors: [], stdout: "", stderr: A1_RATE_LIMIT_ERROR, exitCode: 0 }),
    ).toBe(false);
    expect(detectPiRateLimit1302({ errors: [], stdout: "", stderr: A1_RATE_LIMIT_ERROR })).toBe(false);
  });

  it("trusts stdout only for structured JSON error events on failed terminations", () => {
    const stdout = [
      JSON.stringify({ type: "auto_retry_end", success: false, finalError: A1_RATE_LIMIT_ERROR }),
    ].join("\n");
    expect(detectPiRateLimit1302({ errors: [], stdout, stderr: "", exitCode: 1 })).toBe(true);
    const noisy = `assistant text: we saw 429 once\n${JSON.stringify({ type: "error", message: "boom" })}`;
    expect(detectPiRateLimit1302({ errors: [], stdout: noisy, stderr: "", exitCode: 1 })).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads retry_after seconds and retry_after_ms fields from JSON error payloads", () => {
    expect(
      parseRetryAfterMs({
        errors: ['429: {"code":"1302","retry_after":45,"message":"Rate limit reached for requests"}'],
        stdout: "",
        stderr: "",
      }),
    ).toBe(45_000);
    expect(
      parseRetryAfterMs({ errors: ['{"retryAfterMs": 2500}'], stdout: "", stderr: "" }),
    ).toBe(2_500);
  });

  it("reads Retry-After header seconds and HTTP-date values from stderr", () => {
    const nowMs = Date.parse("2026-11-11T12:00:00.000Z");
    expect(
      parseRetryAfterMs({ errors: [], stdout: "", stderr: "Retry-After: 60\n", exitCode: 1 }, nowMs),
    ).toBe(60_000);
    const dateValue = new Date(nowMs + 90_000).toUTCString();
    expect(
      parseRetryAfterMs({ errors: [], stdout: "", stderr: `Retry-After: ${dateValue}\n` }, nowMs),
    ).toBe(90_000);
  });

  it("reads english 'try again in Xs' hints", () => {
    expect(
      parseRetryAfterMs({ errors: ["429 rate limit, please try again in 12s"], stdout: "", stderr: "" }),
    ).toBe(12_000);
  });

  it("treats numeric values above 300 as already-milliseconds", () => {
    expect(parseRetryAfterMs({ errors: ['{"retry_after": 45000}'], stdout: "", stderr: "" })).toBe(45_000);
  });

  it("clamps unusable values to null", () => {
    expect(parseRetryAfterMs({ errors: ['{"retry_after": 999999}'], stdout: "", stderr: "" })).toBeNull();
    expect(parseRetryAfterMs({ errors: ['{"retry_after": -5}'], stdout: "", stderr: "" })).toBeNull();
    expect(parseRetryAfterMs({ errors: ["plain failure"], stdout: "", stderr: "" })).toBeNull();
    const nowMs = Date.parse("2026-11-11T12:00:00.000Z");
    const pastDate = new Date(nowMs - 60_000).toUTCString();
    expect(
      parseRetryAfterMs({ errors: [], stdout: "", stderr: `Retry-After: ${pastDate}\n` }, nowMs),
    ).toBeNull();
  });
});

describe("computeRateLimitBackoffMs", () => {
  const config = resolvePiRateLimitBackoffConfig({
    PAPERCLIP_PI_429_MAX_RETRIES: "2",
    PAPERCLIP_PI_429_BASE_DELAY_MS: "15000",
    PAPERCLIP_PI_429_MAX_DELAY_MS: "90000",
  });

  it("grows exponentially with the configured caps and adds positive jitter", () => {
    expect(config.baseDelayMs).toBe(15_000);
    expect(config.maxRetries).toBe(2);
    // random() = 0 -> exactly the floor (jitter is strictly additive).
    expect(computeRateLimitBackoffMs(0, null, config, () => 0)).toBe(15_000);
    expect(computeRateLimitBackoffMs(1, null, config, () => 0)).toBe(30_000);
    expect(computeRateLimitBackoffMs(2, null, config, () => 0)).toBe(60_000);
    expect(computeRateLimitBackoffMs(5, null, config, () => 0)).toBe(90_000);
    // random() = 0.5 -> floor + floor * 0.3 * 0.5
    expect(computeRateLimitBackoffMs(0, null, config, () => 0.5)).toBe(15_000 + 2_250);
  });

  it("honors a longer provider Retry-After as the floor and caps it at 5 minutes", () => {
    const withRetryAfter = computeRateLimitBackoffMs(0, 45_000, config, () => 0.5);
    expect(withRetryAfter).toBe(45_000 + Math.round(45_000 * 0.3 * 0.5));
    // Retry-After shorter than the exponential delay does not shorten the wait.
    expect(computeRateLimitBackoffMs(1, 5_000, config, () => 0)).toBe(30_000);
    expect(computeRateLimitBackoffMs(0, 300_000, config, () => 0)).toBe(300_000);
  });
});

describe("resolvePiRateLimitBackoffConfig", () => {
  it("applies defaults and clamps overrides", () => {
    const defaults = resolvePiRateLimitBackoffConfig({});
    expect(defaults).toEqual({
      maxRetries: 2,
      baseDelayMs: 15_000,
      maxDelayMs: 90_000,
      jitterRatio: 0.3,
    });
    expect(resolvePiRateLimitBackoffConfig({ PAPERCLIP_PI_429_MAX_RETRIES: "9" }).maxRetries).toBe(5);
    expect(resolvePiRateLimitBackoffConfig({ PAPERCLIP_PI_429_MAX_RETRIES: "-3" }).maxRetries).toBe(0);
    expect(resolvePiRateLimitBackoffConfig({ PAPERCLIP_PI_429_BASE_DELAY_MS: "20" }).baseDelayMs).toBe(20);
    expect(resolvePiRateLimitBackoffConfig({ PAPERCLIP_PI_429_MAX_DELAY_MS: "junk" }).maxDelayMs).toBe(90_000);
  });
});

describe("shared provider rate-limit gate", () => {
  it("staggers concurrent reservations after an armed cooldown", () => {
    resetPiRateLimitGateForTests();
    const gateKey = buildRateLimitGateKey("zai", "zai");
    expect(gateKey).toBe("pi-local:zai:zai");
    const now = 1_000;
    recordProviderRateLimitCooldown(gateKey, 15_000, now);

    const first = reserveProviderRateLimitSlot(gateKey, now);
    const second = reserveProviderRateLimitSlot(gateKey, now);
    const third = reserveProviderRateLimitSlot(gateKey, now);
    expect(first.waitMs).toBe(15_000);
    // Default 2000ms stagger (+0..15% jitter) per queued reservation.
    expect(second.waitMs).toBeGreaterThanOrEqual(15_000 + 2_000);
    expect(second.waitMs).toBeLessThanOrEqual(15_000 + 2_300);
    expect(third.waitMs).toBeGreaterThanOrEqual(second.waitMs + 2_000);
    expect(third.waitMs).toBeLessThanOrEqual(second.waitMs + 2_300);
  });

  it("lets runs through freely when no cooldown is armed", () => {
    resetPiRateLimitGateForTests();
    const gateKey = buildRateLimitGateKey("zai", "zai");
    expect(reserveProviderRateLimitSlot(gateKey, 1_000).waitMs).toBe(0);
    recordProviderRateLimitCooldown(gateKey, 5_000, 1_000);
    // After the cooldown window has fully passed (and the queue drained),
    // entry is free again.
    expect(reserveProviderRateLimitSlot(gateKey, 20_000).waitMs).toBe(0);
  });

  it("extends an existing cooldown and keeps queued slots behind it", () => {
    resetPiRateLimitGateForTests();
    const gateKey = buildRateLimitGateKey("opencodex", "opencodex");
    recordProviderRateLimitCooldown(gateKey, 10_000, 0);
    recordProviderRateLimitCooldown(gateKey, 30_000, 5_000);
    // Cooldown until max(10s, 5s+30s) = 35s; a reservation at 6s waits ~29s.
    const slot = reserveProviderRateLimitSlot(gateKey, 6_000);
    expect(slot.waitMs).toBe(29_000);
  });
});
