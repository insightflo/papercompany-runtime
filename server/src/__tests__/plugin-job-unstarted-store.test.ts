import {
  createDb,
  pluginJobRuns,
  pluginJobs,
  plugins,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { executeQueuedPluginJob } from "../services/plugin-job-replay.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import { nextCronTick, parseCron } from "../services/cron.js";
import { assertScheduledRunAfterChange } from "./plugin-job-schedule-change-assertions.js";

const PLUGIN_ID = "5361684c-d394-4712-8998-e718ef682147";
const JOB_ID = "0c1feb0a-220f-44b6-a071-fc5b9b11b53b";
const DUE = new Date("2026-10-28T10:00:00.000Z");

describe("plugin queued run ownership", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-job-unstarted-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values({
      id: PLUGIN_ID,
      pluginKey: "fixture.jobs",
      packageName: "@fixture/jobs",
      version: "1.0.0",
      manifestJson: {} as never,
    });
    await db.insert(pluginJobs).values({
      id: JOB_ID,
      pluginId: PLUGIN_ID,
      jobKey: "publish",
      schedule: "0 * * * *",
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginJobRuns);
    await db.update(pluginJobs).set({ schedule: "0 * * * *", nextRunAt: DUE, lastRunAt: null })
      .where(eq(pluginJobs.id, JOB_ID));
  });

  it("protects a scheduled slot without blocking manual runs", async () => {
    const scheduledAt = new Date("2026-10-28T12:00:00.000Z");
    const slot = { jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "schedule" as const, scheduledAt };
    await db.insert(pluginJobRuns).values(slot);
    await expect(db.insert(pluginJobRuns).values(slot)).rejects.toThrow();
    await expect(db.insert(pluginJobRuns).values({ ...slot, trigger: "manual" })).resolves.toBeDefined();
  });

  it("serializes scheduled admission and reuses one queued row", async () => {
    const store = pluginJobStore(db);
    const input = { jobId: JOB_ID, pluginId: PLUGIN_ID };
    const [first, second] = await Promise.all([
      store.createOrReuseQueuedScheduledRun(input),
      store.createOrReuseQueuedScheduledRun(input),
    ]);

    expect(first.run!.id).toBe(second.run!.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await db.select().from(pluginJobRuns)).toHaveLength(1);
    expect(first.run).toMatchObject({ scheduledAt: DUE, scheduledCron: "0 * * * *" });
  });

  it("holds admission when the due slot is missing", async () => {
    await db.update(pluginJobs).set({ nextRunAt: null }).where(eq(pluginJobs.id, JOB_ID));
    const admitted = await pluginJobStore(db).createOrReuseQueuedScheduledRun({ jobId: JOB_ID, pluginId: PLUGIN_ID });
    expect(admitted).toMatchObject({ kind: "held", created: false, run: null, reason: "missing_slot" });
    expect(await db.select().from(pluginJobRuns)).toHaveLength(0);
  });

  it("allows only one queued-to-running claimant", async () => {
    const store = pluginJobStore(db);
    const firstRun = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const secondRun = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    const at = new Date("2026-10-28T12:00:00.000Z");
    const [first, second] = await Promise.all([
      store.claimQueuedRun(firstRun.id, at),
      store.claimQueuedRun(secondRun.id, new Date(at.getTime() + 1)),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([at.getTime(), at.getTime() + 1]).toContain((first ?? second)!.startedAt!.getTime());
  });

  it("does not create a scheduled duplicate while the same job is running", async () => {
    const store = pluginJobStore(db);
    const running = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    await store.claimQueuedRun(running.id);

    const admitted = await store.createOrReuseQueuedScheduledRun({ jobId: JOB_ID, pluginId: PLUGIN_ID });

    expect(admitted).toMatchObject({ created: false, run: { id: running.id, status: "running" } });
    expect(await db.select().from(pluginJobRuns)).toHaveLength(1);
  });

  it("releases only the same unstarted claim and makes it replayable", async () => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    const at = new Date("2026-10-28T12:00:00.000Z");
    const first = await store.claimQueuedRun(run.id, at);
    expect(first?.claimToken).toBeTruthy();
    expect(await store.releaseUnstartedClaim(run.id, first!.claimToken!)).toBe(true);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "queued", startedAt: null, claimToken: null, finishedAt: null });

    const second = await store.claimQueuedRun(run.id, at);
    expect(second?.claimToken).toBeTruthy();
    expect(second!.claimToken).not.toBe(first!.claimToken);
    expect(await store.releaseUnstartedClaim(run.id, first!.claimToken!)).toBe(false);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "running", startedAt: at, claimToken: second!.claimToken });
    expect(await store.releaseUnstartedClaim(run.id, second!.claimToken!)).toBe(true);
  });

  it("lists replayable queued rows oldest first without running rows", async () => {
    const store = pluginJobStore(db);
    const first = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const second = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    await store.claimQueuedRun(first.id);

    await expect(store.listQueuedRunsByPlugin(PLUGIN_ID)).resolves.toMatchObject([{ id: second.id }]);
  });

  it("sends the original scheduled slot to the worker", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPluginJobScheduler({
      db, jobStore: pluginJobStore(db), workerManager: { isRunning: () => true, call } as never,
      runtimeLifecycle: createRuntimeExecutionLifecycle(),
    });
    await scheduler.tick();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({ job: { trigger: "schedule", scheduledAt: DUE.toISOString() } });
    expect(await db.select().from(pluginJobRuns)).toMatchObject([
      { status: "succeeded", scheduledAt: DUE, scheduledCron: "0 * * * *" },
    ]);
    const [run] = await db.select().from(pluginJobRuns);
    expect(await pluginJobStore(db).getJobById(JOB_ID)).toMatchObject({
      lastRunAt: run!.finishedAt, nextRunAt: nextCronTick(parseCron("0 * * * *"), run!.finishedAt!),
    });
  });

  it("rejects stale tokens and treats repeated finalization with the same token as idempotent", async () => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const first = (await store.claimQueuedRun(run.id))!;
    expect(await store.releaseUnstartedClaim(run.id, first.claimToken!)).toBe(true);
    const second = (await store.claimQueuedRun(run.id))!;
    expect(await store.finalizeClaimedRun(run.id, first.claimToken!, { status: "failed" })).toBe("rejected");
    expect(await store.finalizeClaimedRun(run.id, second.claimToken!, { status: "succeeded", durationMs: 5 })).toBe("finalized");
    const completed = await store.getRunById(run.id);
    expect(await store.finalizeClaimedRun(run.id, second.claimToken!, { status: "failed", error: "late" })).toBe("already_finalized");
    expect(await store.getRunById(run.id)).toEqual(completed);
  });

  it("rolls back the terminal result when the schedule pointer update fails", async () => {
    const store = pluginJobStore(db);
    const { run } = await store.createOrReuseQueuedScheduledRun({ jobId: JOB_ID, pluginId: PLUGIN_ID });
    const claimed = (await store.claimQueuedRun(run!.id))!;
    await db.execute(sql`CREATE FUNCTION test_fail_plugin_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected pointer failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER test_fail_plugin_pointer BEFORE UPDATE ON plugin_jobs
      FOR EACH ROW EXECUTE FUNCTION test_fail_plugin_pointer()`);
    try {
      await expect(store.finalizeClaimedRun(run!.id, claimed.claimToken!, { status: "succeeded" })).rejects.toThrow();
      expect(await store.getRunById(run!.id)).toMatchObject({ status: "running", finishedAt: null });
      expect((await store.getJobById(JOB_ID))!.nextRunAt).toEqual(DUE);
    } finally {
      await db.execute(sql`DROP TRIGGER test_fail_plugin_pointer ON plugin_jobs`);
      await db.execute(sql`DROP FUNCTION test_fail_plugin_pointer()`);
    }
    expect(await store.finalizeClaimedRun(run!.id, claimed.claimToken!, { status: "succeeded" })).toBe("finalized");
  });

  it.each(["schedule", "pointer", "schedule_and_pointer", "removed_schedule", "invalid_schedule", "clock_rollback", "update_rollback"] as const)(
    "reconciles a changed %s after a scheduled run", async (change) => {
      await assertScheduledRunAfterChange({ db, jobId: JOB_ID, pluginId: PLUGIN_ID, due: DUE }, change);
    },
  );

  it.each(["manual", "retry"] as const)("does not move the schedule pointer for %s", async (trigger) => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger });
    const claimed = (await store.claimQueuedRun(run.id))!;
    expect(await store.finalizeClaimedRun(run.id, claimed.claimToken!, { status: "succeeded" })).toBe("finalized");
    expect(await store.getJobById(JOB_ID)).toMatchObject({ nextRunAt: DUE, lastRunAt: null });
  });

  it("never releases or replays an uncertain or incomplete claim", async () => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    const claimed = (await store.claimQueuedRun(run.id))!;
    expect(await store.markCompletionUncertain(run.id, crypto.randomUUID())).toBe(false);
    expect(await store.markCompletionUncertain(run.id, claimed.claimToken!)).toBe(true);
    expect(await store.releaseUnstartedClaim(run.id, claimed.claimToken!)).toBe(false);
    expect(await store.listQueuedRunsByPlugin(PLUGIN_ID)).toEqual([]);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "running", finishedAt: null, completionUncertainty: "external_execution_sent_or_unknown" });
    expect(await store.finalizeClaimedRun(run.id, claimed.claimToken!, { status: "succeeded" })).toBe("finalized");
  });

  it("rejects legacy scheduled rows and queued rows with partial execution evidence", async () => {
    const store = pluginJobStore(db);
    const legacy = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "schedule" });
    const unknown = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "scheduled" as never });
    const dirty = await Promise.all(["manual", "manual", "retry", "retry"].map((trigger) =>
      store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: trigger as "manual" | "retry" })));
    const evidence = [
      { startedAt: new Date() }, { finishedAt: new Date() },
      { claimToken: crypto.randomUUID() }, { completionUncertainty: "external_execution_sent_or_unknown" as const },
    ];
    for (const [index, run] of dirty.entries()) {
      await db.update(pluginJobRuns).set(evidence[index]!).where(eq(pluginJobRuns.id, run.id));
    }
    expect(await store.listQueuedRunsByPlugin(PLUGIN_ID)).toEqual([]);
    for (const run of [legacy, unknown, ...dirty]) expect(await store.claimQueuedRun(run.id)).toBeNull();
    expect(await store.createOrReuseQueuedScheduledRun({ jobId: JOB_ID, pluginId: PLUGIN_ID }))
      .toMatchObject({ kind: "held", reason: "missing_slot" });
  });

  it("leaves unknown RPC outcomes nonterminal, while recording an actual worker failure", async () => {
    const store = pluginJobStore(db);
    const job = (await store.getJobById(JOB_ID))!;
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const call = vi.fn().mockRejectedValue(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "timeout" }));
    const input = { job, run, jobStore: store, workerManager: { isRunning: () => true, call } as never, jobTimeoutMs: 10 };
    expect((await executeQueuedPluginJob(input)).kind).toBe("completion_uncertain");
    expect(await store.getRunById(run.id)).toMatchObject({ status: "running", finishedAt: null });
    const failedRun = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    await store.finalizeClaimedRun(run.id, (await store.getRunById(run.id))!.claimToken!, { status: "succeeded" });
    call.mockRejectedValue(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "real failure" }));
    expect(await executeQueuedPluginJob({ ...input, run: failedRun })).toMatchObject({ kind: "settled", status: "failed" });
    expect(await store.getRunById(failedRun.id)).toMatchObject({ status: "failed", error: "real failure" });
  });

  it("does not misclassify a database finalization failure as a worker failure", async () => {
    const store = pluginJobStore(db);
    const job = (await store.getJobById(JOB_ID))!;
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    vi.spyOn(store, "finalizeClaimedRun").mockRejectedValue(new Error("database unavailable"));
    await expect(executeQueuedPluginJob({
      job, run, jobStore: store, workerManager: { isRunning: () => true, call: async () => undefined } as never,
      jobTimeoutMs: 10,
    })).rejects.toThrow("database unavailable");
    expect(await store.getRunById(run.id)).toMatchObject({ status: "running", finishedAt: null, completionUncertainty: null });
  });

  it("releases the exact claim when the worker is unavailable before the call", async () => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const result = await executeQueuedPluginJob({ job: (await store.getJobById(JOB_ID))!, run, jobStore: store,
      workerManager: { isRunning: () => false } as never, jobTimeoutMs: 10 });
    expect(result.kind).toBe("unavailable_before_start");
    expect(await store.getRunById(run.id)).toMatchObject({ status: "queued", claimToken: null, startedAt: null });
  });

  it("marks an additional-start block uncertain without releasing the claim", async () => {
    const store = pluginJobStore(db);
    const job = (await store.getJobById(JOB_ID))!;
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const runtimeLifecycle = { createScope: () => ({ start: () => ({ kind: "additional_start_blocked", externalStarted: true }) }) };
    const result = await executeQueuedPluginJob({
      job, run, jobStore: store, workerManager: { isRunning: () => true } as never,
      jobTimeoutMs: 10, runtimeLifecycle: runtimeLifecycle as never,
    });
    expect(result.kind).toBe("completion_uncertain");
    expect(await store.getRunById(run.id)).toMatchObject({ status: "running", completionUncertainty: "external_execution_sent_or_unknown" });
  });

  it("keeps an in-flight run tracked and records its real result after unregister", async () => {
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const call = vi.fn(() => { started(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const scheduler = createPluginJobScheduler({
      db, jobStore: pluginJobStore(db), workerManager: { isRunning: () => true, call } as never,
      runtimeLifecycle: createRuntimeExecutionLifecycle(),
    });
    const pending = scheduler.tick();
    await startedPromise;
    await scheduler.unregisterPlugin(PLUGIN_ID);
    expect(scheduler.diagnostics().activeJobIds).toContain(JOB_ID);
    expect(await db.select().from(pluginJobRuns)).toMatchObject([{ status: "running", finishedAt: null }]);
    finish();
    await pending;
    expect(scheduler.diagnostics().activeJobCount).toBe(0);
    expect(await db.select().from(pluginJobRuns)).toMatchObject([{ status: "succeeded" }]);
  });
});
