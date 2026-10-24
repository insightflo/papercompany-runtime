import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_TX_TIMEOUT_MS, TxTimeoutError, workflowRuns, type Db } from "@paperclipai/db";
import { withCorrectionDeliveryRoot, type CorrectionDeliveryInput, type CorrectionDeliveryResult,
  type WriteLinkedCorrectionRun } from "../services/workflow/control-flow/qa-correction-delivery-root.js";
import { createCommitSourceHarness, issueDeliveryC02, deliveryInput, deliveryWriter, deliveryState,
  correctionRows, waitForDeliveryLocks } from "./helpers/c02-delivery-fixture.js";

type Profile = "public_callback" | "recovery_skip_locked" | undefined;
type Case = Awaited<ReturnType<typeof issueDeliveryC02>>;
// A local call signature keeps the SAME tests loadable when only the old root is substituted.
const root: (db: Db, input: CorrectionDeliveryInput, writer: WriteLinkedCorrectionRun,
  options?: { transactionProfile?: Profile }) => Promise<CorrectionDeliveryResult> = withCorrectionDeliveryRoot;
function latch() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function by<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
const settled = <T>(pending: Promise<T>) => Promise.allSettled([pending]).then(rows => rows[0]!);
function sqlstate(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let value = error; value && typeof value === "object" && !seen.has(value);) {
    seen.add(value);
    const e = value as { code?: string; cause?: unknown };
    if (e.code) return e.code;
    value = e.cause;
  }
}
async function settings(db: Pick<Db, "execute">) {
  const [row] = await db.execute(sql`SELECT pg_backend_pid() AS pid,
    current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly,
    current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout`);
  return row!;
}
function expectWriterSettings(row: Awaited<ReturnType<typeof settings>>,
  baseline: Awaited<ReturnType<typeof settings>>, profile: Profile) {
  expect(row).toMatchObject({ isolation: "read committed", readonly: "off",
    lock_timeout: profile === "recovery_skip_locked" ? "8s" : baseline.lock_timeout,
    statement_timeout: profile === "recovery_skip_locked" ? "30s" : baseline.statement_timeout });
}
function traceTransactions(db: Db) {
  const queries: string[] = [];
  // Observe the real driver's wire queries; do not replace db.transaction or authority/proof functions.
  db.$client.options.debug = (_connection, query) => { queries.push(query.replace(/\s+/g, " ").trim().toLowerCase()); };
  return queries;
}
function expectTransactions(queries: string[], profile: Profile) {
  const rr = "set transaction isolation level repeatable read read only", rc = "set transaction isolation level read committed";
  const starts = queries.flatMap((q, n) => q.startsWith("set transaction ") ? [n] : []);
  expect(starts.map(n => queries[n])).toContain(rr);
  expect(starts.map(n => queries[n])).toContain(rc);
  expect(starts.every(n => queries[n] === rr || queries[n] === rc)).toBe(true);
  if (profile === "recovery_skip_locked") {
    for (const n of starts) expect(queries.slice(n + 1, n + 3)).toEqual([
      "set local lock_timeout='8s'", "set local statement_timeout='30s'",
    ]);
  } else expect(queries.filter(q => /^set local (lock_timeout|statement_timeout)/.test(q))).toEqual([]);
}
async function activity(db: Db, pid: number) {
  const [row] = await db.execute(sql`SELECT state, wait_event_type, xact_start IS NOT NULL AS in_transaction FROM pg_stat_activity WHERE pid = ${pid}`);
  return row;
}
async function probeLock(db: Db, table: "workflow_runs" | "missions", id: string) {
  try {
    await db.transaction(tx => tx.execute(sql`SELECT id FROM ${sql.raw(table)} WHERE id = ${id} FOR UPDATE NOWAIT`));
    return "released";
  } catch (error) { return sqlstate(error) ?? String(error); }
}
async function expectOne(c: Case) {
  const rows = await correctionRows(c);
  expect(rows.wakes).toHaveLength(1);
  expect(rows.heartbeats).toHaveLength(1);
  expect(rows.receipts).toHaveLength(1);
}
async function retry(c: Case, i: CorrectionDeliveryInput, db: Db, profile: Profile,
  baseline: Awaited<ReturnType<typeof settings>>, queries: string[]) {
  let calls = 0;
  const writer = deliveryWriter(c, async tx => { calls++; expectWriterSettings(await settings(tx), baseline, profile); });
  const result = await root(db, i, writer, { transactionProfile: profile });
  expect(result.kind).toBe("new_delivery");
  expect(calls).toBe(1);
  await expectOne(c);
  expect(await root(db, i, writer, { transactionProfile: profile })).toEqual({
    ...result, kind: "existing_receipt", startRunId: null,
  });
  expect(calls).toBe(1);
  await expectOne(c);
  expectTransactions(queries, profile);
  expect(await settings(db)).toMatchObject({ lock_timeout: baseline.lock_timeout, statement_timeout: baseline.statement_timeout });
}

// C02/C12: preserve the accepted callback30 and recovery SQL8/30 boundaries on actual owned TXs.
// Test-only guards expose the old root's pending TX/held locks and always release gates before DB close.
describe("C02 delivery root transaction timeout preservation", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "delivery-timeout-storage"));
  }, 120000);
  afterAll(async () => {
    try { await owned?.close(); } finally { vi.unstubAllEnvs(); }
  }, 120000);

  async function holdRun(i: CorrectionDeliveryInput) {
    const entered = latch(), release = latch();
    let pid = 0;
    const pending = settled(owned.connect().transaction(async tx => {
      await tx.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, i.companyId),
        eq(workflowRuns.id, i.workflowRunId))).for("update");
      const [backend] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pid = Number(backend!.pid);
      entered.open();
      await release.promise;
    }));
    try {
      expect(await by(entered.promise, 5000)).not.toBeNull();
      return { pid, release, pending };
    } catch (error) {
      release.open();
      await pending;
      throw error;
    }
  }
  async function waiter(c: Case, holderPid: number) {
    const pids = await waitForDeliveryLocks(c.peer, holderPid, 1);
    const [row] = await c.peer.execute(sql`SELECT pid, query, wait_event_type, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE pid = ${pids[0]!}`);
    expect(row).toMatchObject({ wait_event_type: "Lock", blockers: expect.arrayContaining([holderPid]) });
    expect(String(row!.query)).toMatch(/from\s+"workflow_runs".*for no key update/i);
    expect(Number(row!.pid)).not.toBe(holderPid);
    return Number(row!.pid);
  }

  it("public_callback rolls back the real gated writer at DEFAULT_TX_TIMEOUT_MS and releases locks before gate opens", async () => {
    const c = await issueDeliveryC02(owned, "done"), i = await deliveryInput(c), db = owned.connect();
    const before = await deliveryState(c), baseline = await settings(db), queries = traceTransactions(db);
    const entered = latch(), release = latch(), sentinel = Error("c02_timeout_late_writer_sentinel");
    let pid = 0, calls = 0, late: Promise<unknown> | undefined, lateError: unknown;
    const actualWriter = deliveryWriter(c, async tx => {
      const current = await settings(tx);
      expectWriterSettings(current, baseline, "public_callback");
      pid = Number(current.pid);
      entered.open();
      await release.promise;
      throw sentinel;
    });
    const started = Date.now();
    const pending = settled(root(db, i, (tx, wake) => {
      calls++;
      late = actualWriter(tx, wake);
      void late.catch(error => { lateError = error; });
      return late;
    }, { transactionProfile: "public_callback" }));
    try {
      expect(await by(entered.promise, 5000)).not.toBeNull();
      const result = await by(pending, DEFAULT_TX_TIMEOUT_MS + 5000);
      // Capture actual DB evidence even on the old root, before asserting the missing timeout.
      const backend = await activity(c.peer, pid), lock = await probeLock(c.peer, "workflow_runs", i.workflowRunId);
      expect(await correctionRows(c)).toEqual({ wakes: [], heartbeats: [], receipts: [] });
      expect({ status: result?.status ?? "pending", backend, lock }).toMatchObject({
        status: "rejected", backend: { state: "idle", in_transaction: false }, lock: "released",
      });
      if (result?.status !== "rejected") throw Error("actual callback timeout missing");
      expect(result.reason).toBeInstanceOf(TxTimeoutError);
      expect(result.reason.timeoutMs).toBe(DEFAULT_TX_TIMEOUT_MS);
      expect(Date.now() - started).toBeGreaterThanOrEqual(DEFAULT_TX_TIMEOUT_MS);
      expect(calls).toBe(1);
      expect(lateError).toBeUndefined();
      expect(await deliveryState(c)).toEqual(before);
    } finally {
      release.open();
      await Promise.allSettled([pending, ...(late ? [late] : [])]);
      if (late) expect(lateError).toBe(sentinel);
    }
    expect(await deliveryState(c)).toEqual(before);
    await retry(c, i, db, "public_callback", baseline, queries);
  }, 60000);

  it("recovery_skip_locked reports SQLSTATE 55P03 while the exact run blocker is still held", async () => {
    const c = await issueDeliveryC02(owned, "todo"), i = await deliveryInput(c), db = owned.connect();
    const before = await deliveryState(c), baseline = await settings(db), queries = traceTransactions(db);
    const held = await holdRun(i);
    let calls = 0;
    const actualWriter = deliveryWriter(c), started = Date.now();
    const pending = settled(root(db, i, (tx, wake) => { calls++; return actualWriter(tx, wake); },
      { transactionProfile: "recovery_skip_locked" }));
    try {
      const pid = await waiter(c, held.pid);
      const result = await by(pending, 12000);
      const error = result?.status === "rejected" ? result.reason : undefined;
      const backend = await activity(c.peer, pid), missionLock = await probeLock(c.peer, "missions", i.missionId);
      expect(await activity(c.peer, held.pid)).toMatchObject({ state: "idle in transaction", in_transaction: true });
      expect(await correctionRows(c)).toEqual({ wakes: [], heartbeats: [], receipts: [] });
      expect({ status: result?.status ?? "pending", sqlstate: sqlstate(error), backend, missionLock, calls }).toMatchObject({
        status: "rejected", sqlstate: "55P03", backend: { state: "idle", in_transaction: false }, missionLock: "released", calls: 0,
      });
      expect(error).not.toBeInstanceOf(TxTimeoutError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(8000);
      expect(await deliveryState(c)).toEqual(before);
    } finally {
      held.release.open();
      await Promise.all([held.pending, pending]);
      expect((await held.pending).status).toBe("fulfilled");
    }
    await retry(c, i, db, "recovery_skip_locked", baseline, queries);
  }, 45000);

  it.each([undefined, "public_callback"] as const)("%s keeps SQL limits unchanged and proceeds after normal release", async profile => {
    const c = await issueDeliveryC02(owned, "todo"), i = await deliveryInput(c), db = owned.connect();
    // Request data cannot select the trusted profile, even when it spells the recovery option.
    i.request.payload!.transactionProfile = "recovery_skip_locked";
    i.request.contextSnapshot.transactionProfile = "recovery_skip_locked";
    const baseline = await settings(db), queries = traceTransactions(db), held = await holdRun(i);
    let calls = 0;
    const writer = deliveryWriter(c, async tx => {
      calls++;
      expectWriterSettings(await settings(tx), baseline, profile);
    });
    const pending = settled(profile === undefined ? root(db, i, writer)
      : root(db, i, writer, { transactionProfile: profile }));
    try {
      const pid = await waiter(c, held.pid);
      expect(await activity(c.peer, pid)).toMatchObject({ state: "active", wait_event_type: "Lock" });
      expect(calls).toBe(0);
      expect(await correctionRows(c)).toEqual({ wakes: [], heartbeats: [], receipts: [] });
    } finally {
      held.release.open();
      await Promise.all([held.pending, pending]);
      expect((await held.pending).status).toBe("fulfilled");
    }
    const result = await pending;
    expect(result.status).toBe("fulfilled");
    if (result.status !== "fulfilled") throw result.reason;
    expect(result.value.kind).toBe("new_delivery");
    expect(calls).toBe(1);
    await expectOne(c);
    expectTransactions(queries, profile);
    expect(await settings(db)).toMatchObject({ lock_timeout: baseline.lock_timeout, statement_timeout: baseline.statement_timeout });
  }, 30000);
});
