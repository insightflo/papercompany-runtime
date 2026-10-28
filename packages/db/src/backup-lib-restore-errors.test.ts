import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const gunzipAsync = promisify(gunzip);

describe("database restore failure boundaries", () => {
  let source: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let admin: ReturnType<typeof postgres>;
  let root = "";
  let backupFile = "";

  async function createEmptyDatabase(label: string) {
    const name = `rr_${label}_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(source.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    source = await startEmbeddedPostgresTestDatabase("backup-restore-errors-");
    const adminUrl = new URL(source.connectionString);
    adminUrl.pathname = "/postgres";
    admin = postgres(adminUrl.toString(), { max: 1 });
    root = await mkdtemp(path.join(os.tmpdir(), "backup-restore-errors-"));
    backupFile = (await runDatabaseBackup({ connectionString: source.connectionString,
      backupDir: path.join(root, "backup"), retentionDays: 1 })).backupFile;
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await source?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("restores the same backup from plain SQL as well as gzip", async () => {
    const compressed = await readFile(backupFile);
    const plainFile = `${backupFile}.sql`;
    await writeFile(plainFile, await gunzipAsync(compressed));
    const targetUrl = await createEmptyDatabase("plain");
    await runDatabaseRestore({ connectionString: targetUrl, backupFile: plainFile });
    const sql = postgres(targetUrl, { max: 1 });
    try {
      const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM missions`;
      expect(Number(rows[0]?.count)).toBe(0);
    } finally { await sql.end(); }
  }, 120_000);

  it("rejects corrupt gzip and leaves the empty target without a false restored schema", async () => {
    const corruptFile = `${backupFile}.corrupt.gz`;
    await writeFile(corruptFile, "not-a-gzip-backup");
    const targetUrl = await createEmptyDatabase("corrupt");
    await expect(runDatabaseRestore({ connectionString: targetUrl, backupFile: corruptFile }))
      .rejects.toThrow("Failed to restore");
    const sql = postgres(targetUrl, { max: 1 });
    try {
      const rows = await sql<{ relation: string | null }[]>`SELECT to_regclass('public.missions')::text AS relation`;
      expect(rows[0]?.relation).toBeNull();
    } finally { await sql.end(); }
  });
});
