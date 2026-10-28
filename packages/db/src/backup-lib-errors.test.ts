import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const controls = vi.hoisted(() => ({
  beginError: null as Error | null,
  queryError: null as Error | null,
  compressionError: null as Error | null,
}));

vi.mock("postgres", () => {
  const sql = Object.assign(
    async () => {
      if (controls.queryError) throw controls.queryError;
      return [];
    },
    { unsafe: () => ({ values: async () => [] }) },
  );
  const client = {
    begin: async (_options: string, work: (transaction: typeof sql) => Promise<unknown>) => {
      if (controls.beginError) throw controls.beginError;
      return await work(sql);
    },
    end: vi.fn(async () => {}),
  };
  return { default: () => client };
});

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const { Transform } = await import("node:stream");
  return {
    ...actual,
    createGzip: () => controls.compressionError
      ? new Transform({
        transform(_chunk, _encoding, callback) {
          callback(controls.compressionError ?? undefined);
        },
      })
      : actual.createGzip(),
  };
});

import { runDatabaseBackup } from "./backup-lib.js";

let tempDir = "";
let backupDir = "";
let existingBackup = "";

beforeEach(() => {
  controls.beginError = null;
  controls.queryError = null;
  controls.compressionError = null;
  tempDir = mkdtempSync(join(tmpdir(), "paperclip-backup-errors-"));
  backupDir = join(tempDir, "backups");
  mkdirSync(backupDir);
  existingBackup = join(backupDir, "paperclip-existing.sql.gz");
  writeFileSync(existingBackup, "known-good-backup");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function backup() {
  return runDatabaseBackup({
    connectionString: "postgres://unused/test",
    backupDir,
    retentionDays: 1,
  });
}

function expectOnlyExistingBackup() {
  expect(readdirSync(backupDir)).toEqual(["paperclip-existing.sql.gz"]);
  expect(readFileSync(existingBackup, "utf8")).toBe("known-good-backup");
}

describe("runDatabaseBackup failure cleanup", () => {
  it("preserves the original connection or SQL error without creating a backup", async () => {
    const connectionError = new Error("forced connection failure");
    controls.beginError = connectionError;
    await expect(backup()).rejects.toBe(connectionError);
    expectOnlyExistingBackup();

    controls.beginError = null;
    const sqlError = new Error("forced SQL failure");
    controls.queryError = sqlError;
    await expect(backup()).rejects.toBe(sqlError);
    expectOnlyExistingBackup();
  });

  it("removes a failed compression artifact and publishes only a complete backup", async () => {
    const compressionError = new Error("forced compression failure");
    controls.compressionError = compressionError;
    await expect(backup()).rejects.toBe(compressionError);
    expectOnlyExistingBackup();

    controls.compressionError = null;
    const result = await backup();
    expect(existsSync(result.backupFile)).toBe(true);
    expect(readdirSync(backupDir).some((name) => name.endsWith(".partial"))).toBe(false);
    expect(readFileSync(existingBackup, "utf8")).toBe("known-good-backup");
  });
});
