import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC,
  DEFAULT_RUNAWAY_LOG_LIMIT_BYTES,
  resolveAdapterFailedTransientRetryMaxSec,
  resolveQaStepActiveExecutionTimeoutMs,
  resolveRunawayLogLimitBytes,
  resolveStepAwareActiveExecutionTimeoutMs,
  stepTimeoutSignalsFromStep,
} from "../services/heartbeat-stability.js";

describe("heartbeat-stability knobs", () => {
  it("keeps the QA-step stale-timeout at 30min by default and allows env override/disable", () => {
    expect(resolveQaStepActiveExecutionTimeoutMs()).toBe(30 * 60 * 1000);
    expect(resolveQaStepActiveExecutionTimeoutMs({ PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "600" } as NodeJS.ProcessEnv)).toBe(600_000);
    expect(resolveQaStepActiveExecutionTimeoutMs({ PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("defaults the runaway log limit to 16MB (between observed legit 12.8MB and runaway 26MB)", () => {
    expect(DEFAULT_RUNAWAY_LOG_LIMIT_BYTES).toBe(16 * 1024 * 1024);
    expect(resolveRunawayLogLimitBytes(null)).toBe(16 * 1024 * 1024);
  });

  it("resolves the runaway log limit from adapterConfig first, then env, then default", () => {
    expect(resolveRunawayLogLimitBytes(null)).toBe(DEFAULT_RUNAWAY_LOG_LIMIT_BYTES);
    expect(resolveRunawayLogLimitBytes({ runawayLogLimitBytes: 12345 })).toBe(12345);
    expect(resolveRunawayLogLimitBytes({}, { PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "999999" } as NodeJS.ProcessEnv)).toBe(999_999);
    expect(resolveRunawayLogLimitBytes({}, { PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveRunawayLogLimitBytes({ runawayLogLimitBytes: 0 })).toBe(0);
  });

  it("keeps the transient adapter_failed retry window at 300s by default with env override", () => {
    expect(resolveAdapterFailedTransientRetryMaxSec()).toBe(DEFAULT_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC);
    expect(resolveAdapterFailedTransientRetryMaxSec({ PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC: "120" } as NodeJS.ProcessEnv)).toBe(120);
    expect(resolveAdapterFailedTransientRetryMaxSec({ PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("never lowers the stale-timeout base and raises it for explicit step timeouts and QA steps", () => {
    const base = 15 * 60 * 1000;
    expect(resolveStepAwareActiveExecutionTimeoutMs({ baseMs: base, contract: null, qaStepActiveExecutionTimeoutMs: 30 * 60 * 1000 })).toBe(base);
    expect(resolveStepAwareActiveExecutionTimeoutMs({ baseMs: base, contract: { stepTimeoutSeconds: 2400, isQaStep: false }, qaStepActiveExecutionTimeoutMs: 0 })).toBe(2400_000);
    expect(resolveStepAwareActiveExecutionTimeoutMs({ baseMs: base, contract: { stepTimeoutSeconds: 0, isQaStep: true }, qaStepActiveExecutionTimeoutMs: 1800_000 })).toBe(1800_000);
    expect(resolveStepAwareActiveExecutionTimeoutMs({ baseMs: base, contract: { stepTimeoutSeconds: 0, isQaStep: true }, qaStepActiveExecutionTimeoutMs: 0 })).toBe(base);
    expect(resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 0, contract: { stepTimeoutSeconds: 2400, isQaStep: true }, qaStepActiveExecutionTimeoutMs: 1800_000 })).toBe(0);
  });

  it("derives step timeout signals from normalized workflow steps", () => {
    expect(stepTimeoutSignalsFromStep({ id: "validate-report", name: "Validate report", timeoutSeconds: 1900 })).toEqual({
      stepTimeoutSeconds: 1900,
      isQaStep: true,
    });
    expect(stepTimeoutSignalsFromStep({ id: "produce-report", name: "Produce" })).toEqual({
      stepTimeoutSeconds: 0,
      isQaStep: false,
    });
    expect(stepTimeoutSignalsFromStep({ id: "s", timeoutSeconds: Number.NaN })).toEqual({
      stepTimeoutSeconds: 0,
      isQaStep: false,
    });
  });
});
