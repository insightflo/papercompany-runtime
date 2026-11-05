import { pluginJobRuns, pluginJobs, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { nextCronTick, parseCron } from "../services/cron.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";

type Change = "schedule" | "pointer" | "schedule_and_pointer" | "removed_schedule" |
  "invalid_schedule" | "clock_rollback" | "update_rollback";

export async function assertScheduledRunAfterChange(
  input: { db: Db; jobId: string; pluginId: string; due: Date },
  change: Change,
) {
  const { db, jobId, pluginId, due } = input;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(due);
  try {
    const store = pluginJobStore(db);
    const admission = { jobId, pluginId };
    if (change === "removed_schedule" || change === "invalid_schedule") {
      await db.update(pluginJobs).set({ nextRunAt: null }).where(eq(pluginJobs.id, jobId));
      vi.setSystemTime(new Date(due.getTime() - 60_000));
      await createPluginJobScheduler({ db, jobStore: store, workerManager: { isRunning: () => true } as never })
        .registerPlugin(pluginId);
      expect((await store.getJobById(jobId))!.nextRunAt).toEqual(due);
      vi.setSystemTime(due);
    }
    const { run } = await store.createOrReuseQueuedScheduledRun(admission);
    const claimed = (await store.claimQueuedRun(run!.id))!;
    const newSchedule = change === "removed_schedule" ? undefined :
      change === "invalid_schedule" ? "61 * * * *" : "*/5 * * * *";
    if (change !== "pointer") {
      await store.syncJobDeclarations(pluginId, [{ jobKey: "publish", displayName: "Publish", schedule: newSchedule }]);
    }
    const newerPointer = new Date(Math.max(Date.now(), due.getTime()) + 24 * 60 * 60 * 1000);
    if (change === "pointer" || change === "schedule_and_pointer") {
      await db.update(pluginJobs).set({ nextRunAt: newerPointer }).where(eq(pluginJobs.id, jobId));
    }

    expect(await store.createOrReuseQueuedScheduledRun(admission)).toMatchObject({
      created: false, run: { id: run!.id, status: "running" },
    });
    expect(await store.claimQueuedRun(run!.id)).toBeNull();
    expect(await store.finalizeClaimedRun(run!.id, crypto.randomUUID(), { status: "succeeded" })).toBe("rejected");
    expect(await store.getRunById(run!.id)).toMatchObject({ status: "running", finishedAt: null });

    if (change === "clock_rollback" || change === "removed_schedule" || change === "invalid_schedule") {
      vi.setSystemTime(new Date(due.getTime() - 60_000));
    }
    if (change === "update_rollback") {
      await db.execute(sql`CREATE FUNCTION test_fail_changed_plugin_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected changed pointer failure'; END $$`);
      await db.execute(sql`CREATE TRIGGER test_fail_changed_plugin_pointer BEFORE UPDATE ON plugin_jobs
        FOR EACH ROW EXECUTE FUNCTION test_fail_changed_plugin_pointer()`);
      try {
        await expect(store.finalizeClaimedRun(run!.id, claimed.claimToken!, { status: "succeeded" })).rejects.toThrow();
        expect(await store.getRunById(run!.id)).toMatchObject({ status: "running", finishedAt: null });
        expect((await store.getJobById(jobId))!.nextRunAt).toEqual(due);
      } finally {
        await db.execute(sql`DROP TRIGGER test_fail_changed_plugin_pointer ON plugin_jobs`);
        await db.execute(sql`DROP FUNCTION test_fail_changed_plugin_pointer()`);
      }
    }

    expect(await store.finalizeClaimedRun(run!.id, claimed.claimToken!, {
      status: "failed", error: "real failure",
    })).toBe("finalized");
    const completed = (await store.getRunById(run!.id))!;
    expect(completed).toMatchObject({ status: "failed", error: "real failure", scheduledAt: due, scheduledCron: "0 * * * *" });
    let job = (await store.getJobById(jobId))!;

    if (change === "pointer" || change === "schedule_and_pointer") {
      expect(job).toMatchObject({ nextRunAt: newerPointer, lastRunAt: null });
      expect(job.schedule).toBe(change === "pointer" ? "0 * * * *" : newSchedule);
    } else if (change === "removed_schedule" || change === "invalid_schedule") {
      expect(job).toMatchObject({ schedule: newSchedule ?? "", nextRunAt: null, lastRunAt: completed.finishedAt });
      expect(await store.createOrReuseQueuedScheduledRun(admission)).toMatchObject({ kind: "held", reason: "missing_slot" });
      await db.insert(pluginJobRuns).values([
        { jobId, pluginId, trigger: "schedule", status: "succeeded", scheduledAt: new Date(due.getTime() - 3_600_000), scheduledCron: "0 * * * *" },
        { jobId, pluginId, trigger: "schedule", status: "succeeded" },
        { jobId, pluginId, trigger: "manual", status: "succeeded", scheduledAt: new Date(due.getTime() + 86_400_000) },
      ]);
      await store.syncJobDeclarations(pluginId, [{ jobKey: "publish", displayName: "Publish", schedule: "0 * * * *" }]);
      const concurrentPointer = new Date(due.getTime() + 7_200_000);
      const listJobs = store.listJobs.bind(store);
      const listSpy = vi.spyOn(store, "listJobs").mockImplementationOnce(async (...args) => {
        const snapshot = await listJobs(...args);
        await db.update(pluginJobs).set(change === "removed_schedule"
          ? { nextRunAt: concurrentPointer } : { schedule: "*/5 * * * *" }).where(eq(pluginJobs.id, jobId));
        return snapshot;
      });
      const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: { isRunning: () => true } as never });
      await scheduler.registerPlugin(pluginId);
      job = (await store.getJobById(jobId))!;
      expect(job).toMatchObject(change === "removed_schedule"
        ? { nextRunAt: concurrentPointer, schedule: "0 * * * *" }
        : { nextRunAt: null, schedule: "*/5 * * * *" });
      listSpy.mockRestore();
      await db.update(pluginJobs).set({ nextRunAt: null, schedule: "0 * * * *" }).where(eq(pluginJobs.id, jobId));
      vi.setSystemTime(new Date(due.getTime() + 3_600_000));
      await scheduler.registerPlugin(pluginId);
      expect((await store.getJobById(jobId))!.nextRunAt).toEqual(new Date(due.getTime() + 7_200_000));
      await db.update(pluginJobs).set({ nextRunAt: null }).where(eq(pluginJobs.id, jobId));
      vi.setSystemTime(new Date(due.getTime() - 60_000));
      await scheduler.registerPlugin(pluginId);
      job = (await store.getJobById(jobId))!;
      expect(job.nextRunAt).toEqual(new Date(due.getTime() + 3_600_000));
      vi.setSystemTime(due);
      expect(await store.createOrReuseQueuedScheduledRun(admission)).toMatchObject({ kind: "held", reason: "not_due" });
    } else {
      const after = new Date(Math.max(completed.finishedAt!.getTime(), due.getTime()));
      expect(job).toMatchObject({
        schedule: newSchedule, lastRunAt: completed.finishedAt,
        nextRunAt: nextCronTick(parseCron(newSchedule!), after),
      });
    }
    expect(job.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
    expect(await store.createOrReuseQueuedScheduledRun(admission)).toMatchObject({ kind: "held", reason: "not_due" });

    vi.setSystemTime(job.nextRunAt!);
    const [first, second] = await Promise.all([
      store.createOrReuseQueuedScheduledRun(admission), store.createOrReuseQueuedScheduledRun(admission),
    ]);
    expect(first.run).toMatchObject({ status: "queued", scheduledAt: job.nextRunAt, scheduledCron: job.schedule });
    expect(first.run!.id).not.toBe(run!.id);
    expect(second.run!.id).toBe(first.run!.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const claims = await Promise.all([store.claimQueuedRun(first.run!.id), store.claimQueuedRun(first.run!.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.finalizeClaimedRun(run!.id, claimed.claimToken!, { status: "succeeded" })).toBe("already_finalized");
    expect(await store.getRunById(run!.id)).toEqual(completed);
    expect((await store.getJobById(jobId))!.nextRunAt).toEqual(job.nextRunAt);
    expect(await db.select().from(pluginJobRuns)).toHaveLength(
      change === "removed_schedule" || change === "invalid_schedule" ? 5 : 2,
    );
    if (change === "removed_schedule") await assertStaleHistoryRegistrationRace(input);
  } finally {
    vi.useRealTimers();
  }
}

// Pause after the history query actually returns, including inside a transaction.
function pauseHistoryRead(db: Db, pause: () => Promise<void>): Db {
  const wrap = (client: Db): Db => new Proxy(client, {
    get(target, key) {
      if (key === "transaction") return (action: (tx: Db) => Promise<unknown>) =>
        target.transaction((tx) => action(wrap(tx as unknown as Db)));
      if (key === "select") return (...args: unknown[]) => {
        const selection = Reflect.apply(target.select, target, args);
        const from = selection.from.bind(selection);
        selection.from = (table: unknown) => {
          const query = from(table);
          if (table === pluginJobRuns) {
            const limit = query.limit.bind(query);
            query.limit = (...values: unknown[]) => Promise.resolve(limit(...values))
              .then(async (rows) => { await pause(); return rows; });
          }
          return query;
        };
        return selection;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrap(db);
}

async function assertStaleHistoryRegistrationRace(input: { db: Db; jobId: string; pluginId: string; due: Date }) {
  const { db, jobId, pluginId, due } = input;
  const store = pluginJobStore(db);
  const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: { isRunning: () => false } as never });
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const historyRead = new Promise<void>((resolve) => { reached = resolve; });
  const pausedDb = pauseHistoryRead(db, async () => { reached(); await held; });
  const schedulerA = createPluginJobScheduler({ db: pausedDb, jobStore: store, workerManager: { isRunning: () => false } as never });
  await db.delete(pluginJobRuns);
  await db.update(pluginJobs).set({ status: "active", schedule: "0 * * * *", nextRunAt: null }).where(eq(pluginJobs.id, jobId));
  vi.setSystemTime(new Date(due.getTime() - 60_000));
  let registrationB: Promise<void> | undefined;
  let pendingAdmission: ReturnType<typeof store.createOrReuseQueuedScheduledRun> | undefined;
  const registrationA = schedulerA.registerPlugin(pluginId);
  try {
    await Promise.race([historyRead, registrationA.then(() => { throw new Error("history barrier was not reached"); })]);
    let bFinished = false;
    let bError: unknown;
    registrationB = scheduler.registerPlugin(pluginId).then(() => { bFinished = true; }, (error) => { bError = error; bFinished = true; });
    let blocked = false;
    for (let i = 0; i < 250 && !bFinished && !blocked; i++) {
      const waiting = await db.execute(sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%plugin_jobs%'`);
      blocked = waiting.length > 0;
      if (!blocked && !bFinished) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bError).toBeUndefined();
    expect(bFinished || blocked).toBe(true);
    if (blocked) {
      expect(bFinished).toBe(false);
      expect((await store.getJobById(jobId))!.nextRunAt).toBeNull();
      expect(await db.select().from(pluginJobRuns)).toHaveLength(0);
      pendingAdmission = store.createOrReuseQueuedScheduledRun({ jobId, pluginId });
      void pendingAdmission.catch(() => {});
      let admissionBlocked = false;
      for (let i = 0; i < 250 && !admissionBlocked; i++) {
        const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%plugin_jobs%'`);
        admissionBlocked = Number(waiting[0]?.count) >= 2;
        if (!admissionBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(admissionBlocked).toBe(true);
      release();
      await registrationA;
      await registrationB;
      expect(bError).toBeUndefined();
      expect(await pendingAdmission).toMatchObject({ kind: "held", reason: "not_due" });
    }
    expect((await store.getJobById(jobId))!.nextRunAt).toEqual(due);
    vi.setSystemTime(due);
    const admission = { jobId, pluginId };
    const { run } = await store.createOrReuseQueuedScheduledRun(admission);
    const claimed = (await store.claimQueuedRun(run!.id))!;
    await store.syncJobDeclarations(pluginId, [{ jobKey: "publish", displayName: "Publish" }]);
    vi.setSystemTime(new Date(due.getTime() - 60_000));
    expect(await store.finalizeClaimedRun(run!.id, claimed.claimToken!, { status: "succeeded" })).toBe("finalized");
    expect(await store.getRunById(run!.id)).toMatchObject({ status: "succeeded", scheduledAt: due });
    expect((await store.getJobById(jobId))!.nextRunAt).toBeNull();
    await store.syncJobDeclarations(pluginId, [{ jobKey: "publish", displayName: "Publish", schedule: "0 * * * *" }]);
    release();
    await registrationA;
    await registrationB;
    await scheduler.registerPlugin(pluginId);
    const next = new Date(due.getTime() + 3_600_000);
    expect((await store.getJobById(jobId))!.nextRunAt).toEqual(next);
    vi.setSystemTime(next);
    const [first, second] = await Promise.all([
      store.createOrReuseQueuedScheduledRun(admission), store.createOrReuseQueuedScheduledRun(admission),
    ]);
    expect(first.run).toMatchObject({ status: "queued", scheduledAt: next });
    expect(second.run!.id).toBe(first.run!.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await db.select().from(pluginJobRuns)).toHaveLength(2);

    // Every recorded scheduled slot is a floor; unrelated manual timestamps are not.
    for (const status of ["queued", "running", "succeeded", "failed"] as const) {
      await db.delete(pluginJobRuns);
      await db.update(pluginJobs).set({ nextRunAt: null }).where(eq(pluginJobs.id, jobId));
      await db.insert(pluginJobRuns).values([
        { jobId, pluginId, trigger: "schedule", status, scheduledAt: due, scheduledCron: "0 * * * *" },
        { jobId, pluginId, trigger: "manual", status: "succeeded", scheduledAt: new Date(due.getTime() + 86_400_000) },
      ]);
      vi.setSystemTime(new Date(due.getTime() - 60_000));
      await scheduler.registerPlugin(pluginId);
      expect((await store.getJobById(jobId))!.nextRunAt).toEqual(next);
      expect((await db.select().from(pluginJobRuns)).find((row) => row.trigger === "schedule")!.status).toBe(status);
    }

    // A stale active-job list must not seed a definition changed before locking.
    await db.delete(pluginJobRuns);
    for (const changed of [{ status: "paused" }, { schedule: "" }, { schedule: "61 * * * *" }]) {
      await db.update(pluginJobs).set({ status: "active", schedule: "0 * * * *", nextRunAt: null }).where(eq(pluginJobs.id, jobId));
      const listJobs = store.listJobs.bind(store);
      const spy = vi.spyOn(store, "listJobs").mockImplementationOnce(async (...args) => {
        const snapshot = await listJobs(...args);
        await db.update(pluginJobs).set(changed).where(eq(pluginJobs.id, jobId));
        return snapshot;
      });
      try { await scheduler.registerPlugin(pluginId); } finally { spy.mockRestore(); }
      expect((await store.getJobById(jobId))!.nextRunAt).toBeNull();
    }
  } finally {
    release();
    await Promise.allSettled([registrationA, ...(registrationB ? [registrationB] : []), ...(pendingAdmission ? [pendingAdmission] : [])]);
    await db.delete(pluginJobRuns);
    await db.update(pluginJobs).set({ status: "active", schedule: "0 * * * *", nextRunAt: due, lastRunAt: null })
      .where(eq(pluginJobs.id, jobId));
  }
}
