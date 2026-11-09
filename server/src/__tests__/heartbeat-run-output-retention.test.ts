import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  countPgDumpBackends,
  createHeartbeatRunOutputRetentionJob,
  DEFAULT_RUN_OUTPUT_RETENTION_DAYS,
  resolveRunOutputRetentionDays,
  runHeartbeatRunOutputRetention,
} from "../services/heartbeat-run-output-retention.js";

describe("resolveRunOutputRetentionDays", () => {
  it("defaults to 7 enabled days when unset or blank", () => {
    expect(resolveRunOutputRetentionDays(undefined)).toEqual({ enabled: true, days: 7 });
    expect(resolveRunOutputRetentionDays("")).toEqual({ enabled: true, days: 7 });
    expect(resolveRunOutputRetentionDays("   ")).toEqual({ enabled: true, days: 7 });
    expect(DEFAULT_RUN_OUTPUT_RETENTION_DAYS).toBe(7);
  });

  it("accepts integers >= 1 and truncates fractions", () => {
    expect(resolveRunOutputRetentionDays("14")).toEqual({ enabled: true, days: 14 });
    expect(resolveRunOutputRetentionDays("1")).toEqual({ enabled: true, days: 1 });
    expect(resolveRunOutputRetentionDays("365")).toEqual({ enabled: true, days: 365 });
    expect(resolveRunOutputRetentionDays("3.9")).toEqual({ enabled: true, days: 3 });
    expect(resolveRunOutputRetentionDays(" 10 ")).toEqual({ enabled: true, days: 10 });
  });

  it("disables with 0 / off / false (case-insensitive)", () => {
    for (const raw of ["0", "off", "OFF", "Off", "false", "FALSE", "  off  "]) {
      expect(resolveRunOutputRetentionDays(raw)).toEqual({ enabled: false, days: 7 });
    }
  });

  it("falls back to the default with one warning for non-numeric values", () => {
    const warnings: string[] = [];
    expect(resolveRunOutputRetentionDays("abc", (reason) => warnings.push(reason))).toEqual({ enabled: true, days: 7 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'abc'");
    expect(warnings[0]).toContain("7");
  });

  it("falls back to the default with one warning for values below 1 (other than 0)", () => {
    for (const raw of ["-3", "-0.5", "0.5", "0.9"]) {
      const warnings: string[] = [];
      expect(resolveRunOutputRetentionDays(raw, (reason) => warnings.push(reason))).toEqual({ enabled: true, days: 7 });
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("countPgDumpBackends", () => {
  it("reads n from an array-shaped execute result", async () => {
    const db = { execute: async () => [{ n: 2 }] } as unknown as Db;
    await expect(countPgDumpBackends(db)).resolves.toBe(2);
  });

  it("reads n from a rows-shaped execute result", async () => {
    const db = { execute: async () => ({ rows: [{ n: 1 }] }) } as unknown as Db;
    await expect(countPgDumpBackends(db)).resolves.toBe(1);
  });

  it("treats an empty result as zero", async () => {
    const db = { execute: async () => ({}) } as unknown as Db;
    await expect(countPgDumpBackends(db)).resolves.toBe(0);
  });
});

describe("runHeartbeatRunOutputRetention backup-check fail-closed", () => {
  it("treats a failed default backup check as backup-active and writes nothing", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const db = {
        execute: () => {
          throw new Error("pg_stat_activity unavailable");
        },
      } as unknown as Db;
      const result = await runHeartbeatRunOutputRetention(db, { retentionDays: 7 });
      expect(result).toEqual({ skipped: "backup", rowsTruncated: 0, bytesSaved: 0, batches: 0 });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("fail-closed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("aborts the pass when an injected backup check throws", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const db = { execute: async () => [] } as unknown as Db;
      const result = await runHeartbeatRunOutputRetention(db, {
        retentionDays: 7,
        isBackupActive: async () => {
          throw new Error("check exploded");
        },
      });
      expect(result).toEqual({ skipped: "backup", rowsTruncated: 0, bytesSaved: 0, batches: 0 });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("aborting pass"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createHeartbeatRunOutputRetentionJob", () => {
  it("disabled setting: runPass never touches the database", async () => {
    const db = {
      execute: () => {
        throw new Error("disabled job must not query");
      },
    } as unknown as Db;
    const job = createHeartbeatRunOutputRetentionJob(db, { envRaw: "off" });
    const result = await job.runPass();
    expect(result).toEqual({ skipped: "disabled", rowsTruncated: 0, bytesSaved: 0, batches: 0 });
  });

  it("enforces once-per-interval spacing inside a process", async () => {
    const db = { execute: async () => [] } as unknown as Db;
    const job = createHeartbeatRunOutputRetentionJob(db, {
      envRaw: "7",
      intervalMs: 3_600_000,
      isBackupActive: async () => false,
    });
    const first = await job.runPass();
    expect(first.skipped).toBeNull();
    expect(first.rowsTruncated).toBe(0);
    const second = await job.runPass();
    expect(second.skipped).toBe("spaced");
    expect(second.rowsTruncated).toBe(0);
  });

  it("schedules one pass after the initial delay and repeats on the interval", async () => {
    vi.useFakeTimers();
    try {
      let queries = 0;
      const db = { execute: async () => { queries += 1; return []; } } as unknown as Db;
      const job = createHeartbeatRunOutputRetentionJob(db, {
        envRaw: "7",
        intervalMs: 1_000,
        initialDelayMs: 100,
        isBackupActive: async () => false,
      });
      job.start();
      expect(queries).toBe(0);
      await vi.advanceTimersByTimeAsync(101); // 초기 지연(100ms) 후 첫 회
      expect(queries).toBe(1);
      await vi.advanceTimersByTimeAsync(999); // 간격(1,000ms) 경과 → 두 번째 회
      expect(queries).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000); // 세 번째 회
      expect(queries).toBe(3);
      job.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(queries).toBe(3);
      await expect(job.drain()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
