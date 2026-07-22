import { describe, it, expect } from "vitest";
import {
  sanitizeErrorSummary,
  isWorkflowRetryDue,
  readWorkflowRetryMetadata,
  buildWorkflowRetryMetadata,
  appendRetryAttempt,
} from "../services/workflow/retry-metadata.js";

describe("sanitizeErrorSummary", () => {
  it("strips control characters", () => {
    expect(sanitizeErrorSummary("error\x00\x01tab")).toBe("error tab");
  });

  it("truncates to 500 chars", () => {
    const long = "x".repeat(600);
    expect(sanitizeErrorSummary(long)?.length).toBe(500);
  });

  it("returns null for empty", () => {
    expect(sanitizeErrorSummary("")).toBeNull();
    expect(sanitizeErrorSummary(null)).toBeNull();
  });

  it("redacts Authorization header values", () => {
    const result = sanitizeErrorSummary("Request failed: Authorization: Bearer eyJhbGciOiJIUzI1");
    expect(result).not.toContain("eyJhbGciOiJIUzI1");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const result = sanitizeErrorSummary("Bearer dGhpcyBpcyBhIHRva2Vu token expired");
    expect(result).not.toContain("dGhpcyBpcyBhIHRva2Vu");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts OpenAI-style API keys", () => {
    const result = sanitizeErrorSummary("Error: invalid sk-1234567890abcdefghijklmnopqrstuv key");
    expect(result).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts password assignments", () => {
    expect(sanitizeErrorSummary("password=secret123")?.toLowerCase()).not.toContain("secret123");
    expect(sanitizeErrorSummary("password: mypass")?.toLowerCase()).not.toContain("mypass");
    expect(sanitizeErrorSummary("pwd=hunter2")?.toLowerCase()).not.toContain("hunter2");
  });

  it("redacts token and secret assignments", () => {
    expect(sanitizeErrorSummary("token=abc123def456")?.toLowerCase()).not.toContain("abc123def456");
    expect(sanitizeErrorSummary("secret=mysecret")?.toLowerCase()).not.toContain("mysecret");
    expect(sanitizeErrorSummary("access_key=AKIAIOSFODNN7EXAMPLE")?.toLowerCase()).not.toContain("AKIAIOSFODNN7EXAMPLE".toLowerCase());
  });

  it("fails closed for JSON credential fragments", () => {
    const json = '{"api_key":"sk-real-key-value","password":"p@ssw0rd"}';
    const result = sanitizeErrorSummary(json);
    expect(result).toBe("[structured payload]");
    expect(result).not.toContain("sk-real-key-value");
    expect(result).not.toContain("p@ssw0rd");
  });

  it("preserves non-sensitive error text", () => {
    expect(sanitizeErrorSummary("Connection refused: ECONNREFUSED 127.0.0.1:3000")).toContain("Connection refused");
    expect(sanitizeErrorSummary("Tool execution timed out after 30s")).toContain("timed out");
  });

  it("fails closed for structured JSON strings", () => {
    expect(sanitizeErrorSummary('{"error":"oops","secret_key":"abc"}')).toBe("[structured payload]");
    expect(sanitizeErrorSummary('[{"type":"error","message":"fail"}]')).toBe("[structured payload]");
    // Raw object fields are never copied
    const result = sanitizeErrorSummary('{"toolResult":{"stdout":"leaked","stderr":"data"}}');
    expect(result).toBe("[structured payload]");
  });

  it("preserves non-JSON error messages that look like JSON fragments", () => {
    // Not valid JSON — falls through to pattern redaction
    const result = sanitizeErrorSummary('{not valid json but has token=abc123}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
  });
});

describe("isWorkflowRetryDue", () => {
  const due = { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() - 1000).toISOString() } as const;
  const future = { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() + 60_000).toISOString() } as const;

  it("true when nextEligibleAt is in the past", () => {
    expect(isWorkflowRetryDue(due, new Date())).toBe(true);
  });

  it("false when nextEligibleAt is in the future", () => {
    expect(isWorkflowRetryDue(future, new Date())).toBe(false);
  });

  it("true when eligible at exactly now", () => {
    const now = new Date();
    const meta = { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: now.toISOString() };
    expect(isWorkflowRetryDue(meta, now)).toBe(true);
  });

  it("false for malformed metadata", () => {
    expect(isWorkflowRetryDue(null, new Date())).toBe(false);
    expect(isWorkflowRetryDue({}, new Date())).toBe(false);
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: "garbage" }, new Date())).toBe(false);
  });

  it("dispatching is NEVER due, even when nextEligibleAt is in the past", () => {
    const pastDispatching = { state: "dispatching", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() - 1000).toISOString() };
    expect(isWorkflowRetryDue(pastDispatching, new Date())).toBe(false);
    const futureDispatching = { state: "dispatching", retryNumber: 1, maxRetries: 2, nextEligibleAt: new Date(Date.now() + 1000).toISOString() };
    expect(isWorkflowRetryDue(futureDispatching, new Date())).toBe(false);
  });

  it("false when retryNumber/maxRetries are malformed even with a valid due date", () => {
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: NaN, maxRetries: 2, nextEligibleAt: due.nextEligibleAt }, new Date())).toBe(false);
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: 1.5, maxRetries: 2, nextEligibleAt: due.nextEligibleAt }, new Date())).toBe(false);
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: 0, maxRetries: 2, nextEligibleAt: due.nextEligibleAt }, new Date())).toBe(false);
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: 3, maxRetries: 2, nextEligibleAt: due.nextEligibleAt }, new Date())).toBe(false);
    expect(isWorkflowRetryDue({ state: "waiting", retryNumber: -1, maxRetries: 2, nextEligibleAt: due.nextEligibleAt }, new Date())).toBe(false);
  });
});

describe("readWorkflowRetryMetadata", () => {
  it("reads valid metadata", () => {
    const meta = {
      state: "waiting",
      retryNumber: 1,
      maxRetries: 2,
      nextEligibleAt: "2026-01-01T00:00:00.000Z",
      sourceRequestId: "req-1",
      sourceCompletedAt: "2026-01-01T00:00:00.000Z",
      lastErrorSummary: "boom",
    };
    const result = readWorkflowRetryMetadata(meta);
    expect(result).not.toBeNull();
    expect(result?.retryNumber).toBe(1);
  });

  it("returns null for malformed", () => {
    expect(readWorkflowRetryMetadata({ state: "waiting" })).toBeNull();
    expect(readWorkflowRetryMetadata(null)).toBeNull();
  });
});

describe("buildWorkflowRetryMetadata", () => {
  it("computes nextEligibleAt from delay", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const meta = buildWorkflowRetryMetadata({
      retryNumber: 1,
      maxRetries: 2,
      delaySeconds: 30,
      now,
      sourceRequestId: "req-1",
      sourceCompletedAt: now.toISOString(),
      lastErrorSummary: "failed",
    });
    expect(meta.nextEligibleAt).toBe("2026-01-01T00:00:30.000Z");
    expect(meta.state).toBe("waiting");
  });
});

describe("appendRetryAttempt", () => {
  it("appends and caps at 20", () => {
    let history = appendRetryAttempt(undefined, { retryNumber: 1, failedAt: null, errorSummary: null });
    expect(history.length).toBe(1);
    for (let i = 2; i <= 25; i++) {
      history = appendRetryAttempt(history, { retryNumber: i, failedAt: null, errorSummary: null });
    }
    expect(history.length).toBe(20);
    expect(history[19].retryNumber).toBe(25);
  });
});
