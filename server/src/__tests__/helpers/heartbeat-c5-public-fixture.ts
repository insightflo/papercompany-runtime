import { chmod, lstat, mkdir, mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { PYTHON } from "./qa-remediation-parent-death-harness.js";

export { deferred, within } from "./qa-remediation-parent-death-harness.js";

const TEST_ENV_KEYS = [
  "PAPERCLIP_STORAGE_PROVIDER",
  "PAPERCLIP_STORAGE_LOCAL_DIR",
  "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE",
  "PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT",
  "PAPERCLIP_QA_FILE_OWNER_PYTHON",
] as const;

export interface HeartbeatC5PublicFixture {
  readonly db: Db;
  readonly peer: Db;
  readonly root: string;
  readonly storageRoot: string;
  readonly lockRoot: string;
  trackNativeOwner(owner: NativeQaOwner): () => Promise<void>;
  cleanup(): Promise<void>;
}

export interface NativeQaOwner {
  close(): Promise<unknown>;
  awaitExit(): Promise<unknown>;
}

async function restoreFixtureDirectoryPermissions(root: string) {
  const restore = async (directory: string): Promise<void> => {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("C5 fixture cleanup encountered a non-directory root");
    }
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      const childStat = await lstat(child);
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) await restore(child);
    }
  };
  await restore(root);
}

/** Owns only this test's embedded database, peers, native owners, and temporary storage. */
export async function createHeartbeatC5PublicFixture(): Promise<HeartbeatC5PublicFixture> {
  const previousEnv = new Map(TEST_ENV_KEYS.map(key => [key, process.env[key]] as const));
  const temp = await startEmbeddedPostgresTestDatabase("heartbeat-c5-public-");
  const db = createDb(temp.connectionString);
  const peer = createDb(temp.connectionString);
  const createdRoot = await mkdtemp(join(tmpdir(), "heartbeat-c5-public-"));
  const root = await realpath(createdRoot);
  const storageRoot = join(root, "storage");
  const lockRoot = join(root, "qa-owner-locks");
  const cleanupActions: Array<() => Promise<void>> = [];
  let cleaned = false;

  await mkdir(storageRoot, { mode: 0o700 });
  await mkdir(lockRoot, { mode: 0o700 });
  await chmod(lockRoot, 0o700);
  process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
  process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
  process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
  process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = lockRoot;
  process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;

  await db.insert(instanceSettings).values({
    singletonKey: "default",
    experimental: { enableHeartbeatFinalizationV1: true },
  }).onConflictDoUpdate({
    target: instanceSettings.singletonKey,
    set: { experimental: { enableHeartbeatFinalizationV1: true } },
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    for (const action of cleanupActions.splice(0).reverse()) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    try { await waitForHeartbeatExecutionsToDrain(db, 60_000); } catch (error) { failures.push(error); }
    try { await peer.$client.end(); } catch (error) { failures.push(error); }
    try { await db.$client.end(); } catch (error) { failures.push(error); }
    try { await temp.cleanup(); } catch (error) { failures.push(error); }
    try { await restoreFixtureDirectoryPermissions(root); } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "C5 public fixture cleanup failed");
  };

  return {
    db,
    peer,
    root,
    storageRoot,
    lockRoot,
    trackNativeOwner(owner) {
      let settled = false;
      const settle = async () => {
        if (settled) return;
        settled = true;
        const failures: unknown[] = [];
        try { await owner.close(); } catch (error) { failures.push(error); }
        try { await owner.awaitExit(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "C5 native owner cleanup failed");
      };
      cleanupActions.push(settle);
      return settle;
    },
    cleanup,
  };
}
