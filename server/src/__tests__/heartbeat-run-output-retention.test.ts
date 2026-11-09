import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  capHeartbeatRunResultJsonForStorage,
  STORED_OUTPUT_TRUNCATE_THRESHOLD,
} from "../services/heartbeat-run-summary.js";
import {
  countPgDumpBackends,
  createHeartbeatRunOutputRetentionJob,
  DEFAULT_RUN_OUTPUT_RETENTION_DAYS,
  resolveRunOutputRetentionDays,
  runHeartbeatRunOutputRetention,
} from "../services/heartbeat-run-output-retention.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping heartbeat run output retention integration tests: ${support.reason ?? "unsupported environment"}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

describeDb("runHeartbeatRunOutputRetention (embedded postgres)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-output-retention-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Retention Co ${companyId.slice(0, 8)}`,
      issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Retention Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6", command: "/usr/local/bin/claude", env: {} },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(overrides: {
    status?: string;
    createdAt: Date;
    resultJson?: Record<string, unknown> | null;
    finalizationVersion?: number;
    settledAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: overrides.status ?? "succeeded",
      createdAt: overrides.createdAt,
      finalizationVersion: overrides.finalizationVersion ?? 0,
      settledAt: overrides.settledAt ?? null,
      resultJson: overrides.resultJson === undefined ? null : overrides.resultJson,
      stdoutExcerpt: "excerpt stays",
    });
    return id;
  }

  async function fetchRun(id: string) {
    const row = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((rows) => rows[0]);
    if (!row) throw new Error(`run ${id} not found`);
    return row;
  }

  const noBackup = async () => false;

  it("truncates old terminal runs over the 70,000-char boundary with the same marker as new runs", async () => {
    const original = "a".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const id = await seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stdout: original, exitCode: 0, usage: { total_cost_usd: 0.5 } },
      finalizationVersion: 1,
      settledAt: new Date(Date.now() - 8 * DAY_MS + 60_000),
    });
    const before = await fetchRun(id);

    const result = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });

    expect(result.skipped).toBeNull();
    expect(result.rowsTruncated).toBeGreaterThanOrEqual(1);
    expect(result.bytesSaved).toBeGreaterThan(0);
    const after = await fetchRun(id);
    const expected = capHeartbeatRunResultJsonForStorage({ stdout: original })!.stdout;
    expect(after.resultJson?.stdout).toBe(expected);
    expect((after.resultJson?.stdout as string).length).toBeLessThanOrEqual(STORED_OUTPUT_TRUNCATE_THRESHOLD);
    expect(after.resultJson?.stdout).toContain("...[truncated ");
    expect(after.resultJson?.stdout).toContain("full output in run log file");
    // 다른 키·표시 전용 컬럼·상태·updated_at 은 그대로
    expect(after.resultJson?.exitCode).toBe(0);
    expect(after.resultJson?.usage).toEqual({ total_cost_usd: 0.5 });
    expect(after.stdoutExcerpt).toBe("excerpt stays");
    expect(after.status).toBe("succeeded");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("leaves rows at exactly the 70,000-char boundary untouched", async () => {
    const original = "b".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD);
    const id = await seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stdout: original },
    });
    const result = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
    expect(result.rowsTruncated).toBe(0);
  });

  it("leaves rows younger than the retention window untouched", async () => {
    const original = "c".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 5_000);
    const id = await seedRun({
      createdAt: new Date(Date.now() - 6 * DAY_MS),
      resultJson: { stdout: original },
    });
    await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
  });

  it("honours a custom retention-days value for the day boundary", async () => {
    const oldText = "d".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const newText = "e".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const oldId = await seedRun({ createdAt: new Date(Date.now() - 3 * DAY_MS), resultJson: { stdout: oldText } });
    const newId = await seedRun({ createdAt: new Date(Date.now() - 1 * DAY_MS), resultJson: { stdout: newText } });

    await runHeartbeatRunOutputRetention(db, { retentionDays: 2, isBackupActive: noBackup });

    const oldRow = await fetchRun(oldId);
    const newRow = await fetchRun(newId);
    expect(oldRow.resultJson?.stdout).not.toBe(oldText);
    expect(newRow.resultJson?.stdout).toBe(newText);
  });

  it("never touches running, queued, or unsettled runs even when old and oversized", async () => {
    const oversized = "f".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 10_000);
    const runningId = await seedRun({ status: "running", createdAt: new Date(Date.now() - 9 * DAY_MS), resultJson: { stdout: oversized } });
    const queuedId = await seedRun({ status: "queued", createdAt: new Date(Date.now() - 9 * DAY_MS), resultJson: { stdout: oversized } });
    const unsettledId = await seedRun({
      createdAt: new Date(Date.now() - 9 * DAY_MS),
      resultJson: { stdout: oversized },
      finalizationVersion: 1,
      settledAt: null,
    });

    await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });

    for (const id of [runningId, queuedId, unsettledId]) {
      const row = await fetchRun(id);
      expect(row.resultJson?.stdout).toBe(oversized);
      expect(row.status).toBe(id === unsettledId ? "succeeded" : id === runningId ? "running" : "queued");
    }
  });

  it("truncates oversized stderr as well (stdout optional)", async () => {
    const stderr = "g".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 2_000);
    const id = await seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stderr, note: "kept" },
      finalizationVersion: 1,
      settledAt: new Date(),
    });
    await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fetchRun(id);
    const expected = capHeartbeatRunResultJsonForStorage({ stderr })!.stderr;
    expect(row.resultJson?.stderr).toBe(expected);
    expect(row.resultJson?.note).toBe("kept");
  });

  it("ignores rows whose result_json is not an object", async () => {
    // 계약 밖 레거시 방어: jsonb 에 배열/원시값이 들어 있는 행은 후보 선별에서
    // 제외되고(테스트 시드 전용 직접 INSERT), 절단 사이클도 오류 없이 통과한다.
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at, result_json)
      VALUES (${id}, ${companyId}, ${agentId}, 'succeeded', ${new Date(Date.now() - 8 * DAY_MS).toISOString()}::timestamptz, ${JSON.stringify(["not", "an", "object"])}::jsonb)
    `);
    const before = await fetchRun(id);

    const result = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });

    expect(result.skipped).toBeNull();
    const after = await fetchRun(id);
    expect(after.resultJson).toEqual(before.resultJson);
  });

  it("is idempotent: a second pass truncates nothing and keeps values identical", async () => {
    const original = "h".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 3_000);
    const id = await seedRun({ createdAt: new Date(Date.now() - 8 * DAY_MS), resultJson: { stdout: original } });

    const first = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });
    expect(first.rowsTruncated).toBeGreaterThanOrEqual(1);
    const afterFirst = await fetchRun(id);

    const second = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: noBackup });
    expect(second.rowsTruncated).toBe(0);
    expect(second.batches).toBe(0);
    expect(second.bytesSaved).toBe(0);
    const afterSecond = await fetchRun(id);
    expect(afterSecond.resultJson).toEqual(afterFirst.resultJson);
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
  });

  it("skips the whole pass while a backup is running", async () => {
    const original = "i".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const id = await seedRun({ createdAt: new Date(Date.now() - 8 * DAY_MS), resultJson: { stdout: original } });

    const result = await runHeartbeatRunOutputRetention(db, { retentionDays: 7, isBackupActive: async () => true });

    expect(result).toEqual({ skipped: "backup", rowsTruncated: 0, bytesSaved: 0, batches: 0 });
    const row = await fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
  });
});
