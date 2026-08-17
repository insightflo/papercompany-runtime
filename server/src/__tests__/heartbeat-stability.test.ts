import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC,
  DEFAULT_NO_PROGRESS_ADVISORY_THRESHOLD,
  DEFAULT_NO_PROGRESS_AUTO_BLOCK_THRESHOLD,
  DEFAULT_NO_PROGRESS_WINDOW_MS,
  DEFAULT_RUNAWAY_LOG_LIMIT_BYTES,
  hasRunProgressEvidence,
  resolveAdapterFailedTransientRetryMaxSec,
  resolveNoProgressAdvisoryThreshold,
  resolveNoProgressAutoBlockThreshold,
  resolveNoProgressWindowMs,
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

describe("no-progress ladder knobs", () => {
  it("defaults the ladder to N=2 advisory / K=3 block / 6h window with env overrides and 0-disable", () => {
    expect(DEFAULT_NO_PROGRESS_ADVISORY_THRESHOLD).toBe(2);
    expect(DEFAULT_NO_PROGRESS_AUTO_BLOCK_THRESHOLD).toBe(3);
    expect(DEFAULT_NO_PROGRESS_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
    expect(resolveNoProgressAdvisoryThreshold()).toBe(2);
    expect(resolveNoProgressAdvisoryThreshold({ PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD: "4" } as NodeJS.ProcessEnv)).toBe(4);
    expect(resolveNoProgressAdvisoryThreshold({ PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveNoProgressAutoBlockThreshold()).toBe(3);
    expect(resolveNoProgressAutoBlockThreshold({ PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(resolveNoProgressAutoBlockThreshold({ PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveNoProgressWindowMs()).toBe(DEFAULT_NO_PROGRESS_WINDOW_MS);
    expect(resolveNoProgressWindowMs({ PAPERCLIP_NO_PROGRESS_WINDOW_SEC: "3600" } as NodeJS.ProcessEnv)).toBe(3_600_000);
    expect(resolveNoProgressWindowMs({ PAPERCLIP_NO_PROGRESS_WINDOW_SEC: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("hasRunProgressEvidence (구조화 DB 증거만 판정)", () => {
  const run = {
    id: "run-1",
    startedAt: new Date("2026-08-17T04:00:00Z"),
    finishedAt: new Date("2026-08-17T04:05:00Z"),
    createdAt: new Date("2026-08-17T04:00:00Z"),
  };
  const empty = { workProductRunIds: new Set<string>(), transitionRunIds: new Set<string>(), agentCommentTimestamps: [] };

  it("counts a work product registered by the run as progress", () => {
    expect(hasRunProgressEvidence({ run, ...empty, workProductRunIds: new Set(["run-1"]) })).toBe(true);
  });

  it("counts a workflow transition recorded by the run as progress", () => {
    expect(hasRunProgressEvidence({ run, ...empty, transitionRunIds: new Set(["run-1"]) })).toBe(true);
  });

  it("counts an agent comment left inside the run window as progress (inclusive bounds, no body parsing)", () => {
    expect(hasRunProgressEvidence({ run, ...empty, agentCommentTimestamps: [new Date("2026-08-17T04:02:30Z")] })).toBe(true);
    expect(hasRunProgressEvidence({ run, ...empty, agentCommentTimestamps: [run.startedAt] })).toBe(true);
    expect(hasRunProgressEvidence({ run, ...empty, agentCommentTimestamps: [run.finishedAt] })).toBe(true);
  });

  it("treats comments outside the run window as no progress", () => {
    expect(hasRunProgressEvidence({ run, ...empty, agentCommentTimestamps: [new Date("2026-08-17T03:59:59Z")] })).toBe(false);
    expect(hasRunProgressEvidence({ run, ...empty, agentCommentTimestamps: [new Date("2026-08-17T04:05:01Z")] })).toBe(false);
  });

  it("returns false when no structured evidence exists (usage tokens are never the sole signal)", () => {
    expect(hasRunProgressEvidence({ run, ...empty })).toBe(false);
  });

  it("falls back to createdAt bounds when startedAt/finishedAt are null", () => {
    const degenerate = { ...run, startedAt: null, finishedAt: null };
    const atCreation = new Date("2026-08-17T04:00:00Z");
    expect(hasRunProgressEvidence({ run: degenerate, ...empty, agentCommentTimestamps: [atCreation] })).toBe(true);
    expect(hasRunProgressEvidence({ run: degenerate, ...empty, agentCommentTimestamps: [new Date("2026-08-17T04:00:01Z")] })).toBe(false);
  });
});
