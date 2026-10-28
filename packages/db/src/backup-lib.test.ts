import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import postgres from "postgres";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";

type Sql = ReturnType<typeof postgres>;
type EmbeddedPostgres = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags: string[];
  onLog(message: unknown): void;
  onError(message: unknown): void;
}) => EmbeddedPostgres;
type BackupOutcome = { ok: true; backupFile: string } | { ok: false; error: unknown };

const databaseNames = ["backup_source", "ordinary_target", "options_target", "race_source", "race_target", "failure_source"];
let tempDir = "";
let embedded: EmbeddedPostgres | undefined;
let admin: Sql | undefined;
let urls: Record<string, string> = {};

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate localhost port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function withDatabase<T>(connectionString: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 5, connection: { statement_timeout: 3_000 } });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

async function waitForChildCountLock(
  monitor: Sql,
  database: string,
  outcome: Promise<BackupOutcome>,
): Promise<number | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const settled = await Promise.race([outcome, Promise.resolve(null)]);
    if (settled && !settled.ok) throw settled.error;
    const rows = await monitor<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = ${database} AND state = 'active' AND wait_event_type = 'Lock'
        AND lower(query) LIKE '%count(*)%' AND lower(query) LIKE '%zz_child%'
      LIMIT 1
    `;
    if (rows[0]) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "paperclip-backup-lib-test-"));
  const { default: EmbeddedPostgresClass } = await import("embedded-postgres") as { default: EmbeddedPostgresCtor };
  const port = await availablePort();
  embedded = new EmbeddedPostgresClass({
    databaseDir: join(tempDir, "postgres-data"),
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await embedded.initialise();
  await embedded.start();
  admin = postgres(`postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`, { max: 1, connect_timeout: 5 });
  urls = Object.fromEntries(databaseNames.map((name) => [name, `postgres://paperclip:paperclip@127.0.0.1:${port}/${name}`]));
  for (const name of databaseNames) await admin.unsafe(`CREATE DATABASE "${name}"`);
}, 120_000);

afterAll(async () => {
  if (admin) await admin.end();
  if (embedded) await embedded.stop().catch(() => {});
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("runDatabaseBackup source snapshot", () => {
  it("preserves ordinary/options output, sees one row snapshot under a controlled race, and releases failed reads", async () => {
    await withDatabase(urls.backup_source, async (sql) => {
      for (const statement of [
        "CREATE TYPE public.backup_phase AS ENUM ('ready', 'running')",
        "CREATE TABLE public.aa_parent (id serial PRIMARY KEY, label text NOT NULL, phase public.backup_phase NOT NULL, payload jsonb NOT NULL, nullable_note text, nullify_me text)",
        "CREATE TABLE public.zz_child (id serial PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.aa_parent(id), label text)",
        "CREATE SCHEMA drizzle",
        "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)",
        "INSERT INTO public.aa_parent (label, phase, payload, nullable_note, nullify_me) VALUES ('parent-1', 'ready', '{\"enabled\":true,\"version\":1}', NULL, 'nullify-this-value')",
        "INSERT INTO public.zz_child (parent_id, label) VALUES (1, NULL)",
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('migration-1', 1)",
      ]) await sql.unsafe(statement);
    });

    const ordinaryFile = await runDatabaseBackup({
      connectionString: urls.backup_source,
      backupDir: join(tempDir, "ordinary"),
      retentionDays: 1,
    });
    await runDatabaseRestore({ connectionString: urls.ordinary_target, backupFile: ordinaryFile.backupFile });
    const ordinary = await withDatabase(urls.ordinary_target, async (sql) => ({
      parents: await sql<{ id: number; label: string; phase: string; payload: unknown; nullable_note: string | null; nullify_me: string | null }[]>`
        SELECT id, label, phase::text AS phase, payload, nullable_note, nullify_me FROM public.aa_parent ORDER BY id
      `,
      children: await sql<{ id: number; parent_id: number; label: string | null }[]>`
        SELECT id, parent_id, label FROM public.zz_child ORDER BY id
      `,
      fkCount: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND conname = 'zz_child_parent_id_fkey'`,
      orphanCount: await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM public.zz_child c LEFT JOIN public.aa_parent p ON p.id = c.parent_id WHERE p.id IS NULL
      `,
      enumExists: await sql<{ exists: boolean }[]>`SELECT to_regtype('public.backup_phase') IS NOT NULL AS exists`,
      nextParentId: await sql<{ id: number }[]>`SELECT nextval(pg_get_serial_sequence('public.aa_parent', 'id'))::int AS id`,
      journalAbsent: await sql<{ absent: boolean }[]>`SELECT to_regclass('drizzle.__drizzle_migrations') IS NULL AS absent`,
    }));
    expect(ordinary.parents).toEqual([{
      id: 1,
      label: "parent-1",
      phase: "ready",
      payload: { enabled: true, version: 1 },
      nullable_note: null,
      nullify_me: "nullify-this-value",
    }]);
    expect(ordinary.children).toEqual([{ id: 1, parent_id: 1, label: null }]);
    expect(Number(ordinary.fkCount[0]?.count)).toBe(1);
    expect(Number(ordinary.orphanCount[0]?.count)).toBe(0);
    expect(ordinary.enumExists[0]?.exists).toBe(true);
    expect(Number(ordinary.nextParentId[0]?.id)).toBe(2);
    expect(ordinary.journalAbsent[0]?.absent).toBe(true);

    const optionsFile = await runDatabaseBackup({
      connectionString: urls.backup_source,
      backupDir: join(tempDir, "options"),
      retentionDays: 1,
      filenamePrefix: "options",
      includeMigrationJournal: true,
      excludeTables: ["zz_child"],
      nullifyColumns: { aa_parent: ["nullify_me"] },
    });
    await runDatabaseRestore({ connectionString: urls.options_target, backupFile: optionsFile.backupFile });
    const options = await withDatabase(urls.options_target, async (sql) => ({
      migration: await sql<{ hash: string; created_at: string }[]>`
        SELECT hash, created_at::text FROM drizzle.__drizzle_migrations
      `,
      childExists: await sql<{ exists: boolean }[]>`SELECT to_regclass('public.zz_child') IS NOT NULL AS exists`,
      childCount: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM public.zz_child`,
      fkCount: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND conname = 'zz_child_parent_id_fkey'`,
      nullifiedValue: await sql<{ value: string | null }[]>`SELECT nullify_me AS value FROM public.aa_parent`,
    }));
    expect(basename(optionsFile.backupFile).startsWith("options-")).toBe(true);
    expect(options.migration[0]).toMatchObject({ hash: "migration-1", created_at: "1" });
    expect(options.childExists[0]?.exists).toBe(true);
    expect(Number(options.childCount[0]?.count)).toBe(0);
    expect(Number(options.fkCount[0]?.count)).toBe(1);
    expect(options.nullifiedValue[0]?.value).toBeNull();

    await withDatabase(urls.race_source, async (sql) => {
      await sql.unsafe("CREATE TABLE public.aa_parent (id integer PRIMARY KEY, label text NOT NULL)");
      await sql.unsafe("CREATE TABLE public.zz_child (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.aa_parent(id))");
      await sql.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (1, 'before-1'), (2, 'before-2')");
      await sql.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (1, 1), (2, 2)");
    });

    const locker = postgres(urls.race_source, { max: 1, connect_timeout: 5 });
    const monitor = postgres(urls.race_source, { max: 1, connect_timeout: 5 });
    let lockHeld = false;
    let raceOutcome: Promise<BackupOutcome> | undefined;
    try {
      await locker.unsafe("BEGIN");
      await locker.unsafe("LOCK TABLE public.zz_child IN ACCESS EXCLUSIVE MODE");
      lockHeld = true;
      raceOutcome = runDatabaseBackup({
        connectionString: urls.race_source,
        backupDir: join(tempDir, "race"),
        retentionDays: 1,
      }).then(
        (result) => ({ ok: true as const, backupFile: result.backupFile }),
        (error) => ({ ok: false as const, error }),
      );
      const pid = await waitForChildCountLock(monitor, "race_source", raceOutcome);
      if (pid === null) {
        await locker.unsafe("ROLLBACK");
        lockHeld = false;
        await raceOutcome;
        throw new Error("Backup did not reach the locked zz_child count query");
      }

      await withDatabase(urls.race_source, async (writer) => {
        await writer.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (4, 'ordinary-write')");
      });
      await locker.unsafe("UPDATE public.aa_parent SET label = 'after-1' WHERE id = 1");
      await locker.unsafe("DELETE FROM public.zz_child WHERE id = 2");
      await locker.unsafe("DELETE FROM public.aa_parent WHERE id = 2");
      await locker.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (3, 'after-3')");
      await locker.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (3, 3)");
      await locker.unsafe("COMMIT");
      lockHeld = false;
      const result = await raceOutcome;
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      await runDatabaseRestore({ connectionString: urls.race_target, backupFile: result.backupFile });
    } finally {
      if (lockHeld) await locker.unsafe("ROLLBACK").catch(() => {});
      await Promise.all([locker.end(), monitor.end()]);
    }

    const raceRows = await withDatabase(urls.race_target, async (sql) => ({
      parents: await sql<{ id: number; label: string }[]>`SELECT id, label FROM public.aa_parent ORDER BY id`,
      children: await sql<{ id: number; parent_id: number }[]>`SELECT id, parent_id FROM public.zz_child ORDER BY id`,
      orphans: await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM public.zz_child c LEFT JOIN public.aa_parent p ON p.id = c.parent_id WHERE p.id IS NULL
      `,
    }));
    const finalSource = await withDatabase(urls.race_source, async (sql) => ({
      parents: await sql<{ id: number; label: string }[]>`SELECT id, label FROM public.aa_parent ORDER BY id`,
      children: await sql<{ id: number; parent_id: number }[]>`SELECT id, parent_id FROM public.zz_child ORDER BY id`,
      orphans: await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM public.zz_child c LEFT JOIN public.aa_parent p ON p.id = c.parent_id WHERE p.id IS NULL
      `,
    }));
    expect(finalSource.parents).toEqual([
      { id: 1, label: "after-1" },
      { id: 3, label: "after-3" },
      { id: 4, label: "ordinary-write" },
    ]);
    expect(finalSource.children).toEqual([{ id: 1, parent_id: 1 }, { id: 3, parent_id: 3 }]);
    expect(Number(finalSource.orphans[0]?.count)).toBe(0);
    expect(raceRows.parents).toEqual([{ id: 1, label: "before-1" }, { id: 2, label: "before-2" }]);
    expect(raceRows.children).toEqual([{ id: 1, parent_id: 1 }, { id: 2, parent_id: 2 }]);
    expect(Number(raceRows.orphans[0]?.count)).toBe(0);

    await withDatabase(urls.failure_source, async (sql) => {
      await sql.unsafe("CREATE TABLE public.aa_parent (id integer PRIMARY KEY)");
      await sql.unsafe("CREATE TABLE public.zz_child (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.aa_parent(id))");
      await sql.unsafe("INSERT INTO public.aa_parent (id) VALUES (1)");
      await sql.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (1, 1)");
    });
    const failureLocker = postgres(urls.failure_source, { max: 1, connect_timeout: 5 });
    const failureMonitor = postgres(urls.failure_source, { max: 1, connect_timeout: 5 });
    const failureDir = join(tempDir, "failed-backup");
    let failureLockHeld = false;
    try {
      await failureLocker.unsafe("BEGIN");
      await failureLocker.unsafe("LOCK TABLE public.zz_child IN ACCESS EXCLUSIVE MODE");
      failureLockHeld = true;
      const failureOutcome = runDatabaseBackup({
        connectionString: urls.failure_source,
        backupDir: failureDir,
        retentionDays: 1,
      }).then(
        (result) => ({ ok: true as const, backupFile: result.backupFile }),
        (error) => ({ ok: false as const, error }),
      );
      const pid = await waitForChildCountLock(failureMonitor, "failure_source", failureOutcome);
      if (pid === null) {
        await failureLocker.unsafe("ROLLBACK");
        failureLockHeld = false;
        await failureOutcome;
        throw new Error("Backup did not reach the locked query for the failure-path check");
      }
      const terminated = await failureMonitor<{ terminated: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS terminated`;
      expect(terminated[0]?.terminated).toBe(true);
      const failed = await failureOutcome;
      expect(failed.ok).toBe(false);
      expect(existsSync(failureDir)).toBe(false);
      const remaining = await failureMonitor<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ${pid}`;
      expect(Number(remaining[0]?.count)).toBe(0);
    } finally {
      if (failureLockHeld) await failureLocker.unsafe("ROLLBACK").catch(() => {});
      await Promise.all([failureLocker.end(), failureMonitor.end()]);
    }
  }, 120_000);
});
