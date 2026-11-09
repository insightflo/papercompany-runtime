import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  capHeartbeatRunResultJsonForStorage,
  STORED_OUTPUT_TRUNCATE_THRESHOLD,
} from "../services/heartbeat-run-summary.js";
import { runHeartbeatRunOutputRetention } from "../services/heartbeat-run-output-retention.js";
import {
  DAY_MS,
  describeRetentionDb,
  noBackup,
  startRetentionTestDb,
  type RetentionTestDb,
} from "./helpers/heartbeat-run-output-retention-fixture.js";

describeRetentionDb("runHeartbeatRunOutputRetention (embedded postgres)", () => {
  let fx: RetentionTestDb;

  beforeAll(async () => {
    fx = await startRetentionTestDb();
  }, 60_000);

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("truncates old terminal runs over the 70,000-char boundary with the same marker as new runs", async () => {
    const original = "a".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const id = await fx.seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stdout: original, exitCode: 0, usage: { total_cost_usd: 0.5 } },
      finalizationVersion: 1,
      settledAt: new Date(Date.now() - 8 * DAY_MS + 60_000),
    });
    const before = await fx.fetchRun(id);

    const result = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });

    expect(result.skipped).toBeNull();
    expect(result.rowsTruncated).toBeGreaterThanOrEqual(1);
    expect(result.bytesSaved).toBeGreaterThan(0);
    const after = await fx.fetchRun(id);
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
    const id = await fx.seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stdout: original },
    });
    const result = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fx.fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
    expect(result.rowsTruncated).toBe(0);
  });

  it("leaves rows younger than the retention window untouched", async () => {
    const original = "c".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 5_000);
    const id = await fx.seedRun({
      createdAt: new Date(Date.now() - 6 * DAY_MS),
      resultJson: { stdout: original },
    });
    await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fx.fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
  });

  it("honours a custom retention-days value for the day boundary", async () => {
    const oldText = "d".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const newText = "e".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const oldId = await fx.seedRun({ createdAt: new Date(Date.now() - 3 * DAY_MS), resultJson: { stdout: oldText } });
    const newId = await fx.seedRun({ createdAt: new Date(Date.now() - 1 * DAY_MS), resultJson: { stdout: newText } });

    await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 2, isBackupActive: noBackup });

    const oldRow = await fx.fetchRun(oldId);
    const newRow = await fx.fetchRun(newId);
    expect(oldRow.resultJson?.stdout).not.toBe(oldText);
    expect(newRow.resultJson?.stdout).toBe(newText);
  });

  it("never touches running, queued, or unsettled runs even when old and oversized", async () => {
    const oversized = "f".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 10_000);
    const runningId = await fx.seedRun({ status: "running", createdAt: new Date(Date.now() - 9 * DAY_MS), resultJson: { stdout: oversized } });
    const queuedId = await fx.seedRun({ status: "queued", createdAt: new Date(Date.now() - 9 * DAY_MS), resultJson: { stdout: oversized } });
    const unsettledId = await fx.seedRun({
      createdAt: new Date(Date.now() - 9 * DAY_MS),
      resultJson: { stdout: oversized },
      finalizationVersion: 1,
      settledAt: null,
    });

    await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });

    for (const id of [runningId, queuedId, unsettledId]) {
      const row = await fx.fetchRun(id);
      expect(row.resultJson?.stdout).toBe(oversized);
      expect(row.status).toBe(id === unsettledId ? "succeeded" : id === runningId ? "running" : "queued");
    }
  });

  it("truncates oversized stderr as well (stdout optional)", async () => {
    const stderr = "g".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 2_000);
    const id = await fx.seedRun({
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      resultJson: { stderr, note: "kept" },
      finalizationVersion: 1,
      settledAt: new Date(),
    });
    await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });
    const row = await fx.fetchRun(id);
    const expected = capHeartbeatRunResultJsonForStorage({ stderr })!.stderr;
    expect(row.resultJson?.stderr).toBe(expected);
    expect(row.resultJson?.note).toBe("kept");
  });

  it("ignores rows whose result_json is not an object", async () => {
    // 계약 밖 레거시 방어: jsonb 에 배열/원시값이 들어 있는 행은 후보 선별에서
    // 제외되고(테스트 시드 전용 직접 INSERT), 절단 사이클도 오류 없이 통과한다.
    const id = randomUUID();
    await fx.db.execute(sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at, result_json)
      VALUES (${id}, ${fx.companyId}, ${fx.agentId}, 'succeeded', ${new Date(Date.now() - 8 * DAY_MS).toISOString()}::timestamptz, ${JSON.stringify(["not", "an", "object"])}::jsonb)
    `);
    const before = await fx.fetchRun(id);

    const result = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });

    expect(result.skipped).toBeNull();
    const after = await fx.fetchRun(id);
    expect(after.resultJson).toEqual(before.resultJson);
  });

  it("is idempotent: a second pass truncates nothing and keeps values identical", async () => {
    const original = "h".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 3_000);
    const id = await fx.seedRun({ createdAt: new Date(Date.now() - 8 * DAY_MS), resultJson: { stdout: original } });

    const first = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });
    expect(first.rowsTruncated).toBeGreaterThanOrEqual(1);
    const afterFirst = await fx.fetchRun(id);

    const second = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: noBackup });
    expect(second.rowsTruncated).toBe(0);
    expect(second.batches).toBe(0);
    expect(second.bytesSaved).toBe(0);
    const afterSecond = await fx.fetchRun(id);
    expect(afterSecond.resultJson).toEqual(afterFirst.resultJson);
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
  });

  it("skips the whole pass while a backup is running", async () => {
    const original = "i".repeat(STORED_OUTPUT_TRUNCATE_THRESHOLD + 1);
    const id = await fx.seedRun({ createdAt: new Date(Date.now() - 8 * DAY_MS), resultJson: { stdout: original } });

    const result = await runHeartbeatRunOutputRetention(fx.db, { retentionDays: 7, isBackupActive: async () => true });

    expect(result).toEqual({ skipped: "backup", rowsTruncated: 0, bytesSaved: 0, batches: 0 });
    const row = await fx.fetchRun(id);
    expect(row.resultJson?.stdout).toBe(original);
  });
});
