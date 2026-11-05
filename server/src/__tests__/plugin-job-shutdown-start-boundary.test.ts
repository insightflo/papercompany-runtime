import {
  createDb,
  pluginJobRuns,
  pluginJobs,
  plugins,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const PLUGIN_ID = "07988f19-b99e-43d1-9e79-c6f4a6ad1f79";
const JOB_ID = "9e31fc24-3e60-4bd3-97db-0e1f53064e86";
const DUE = new Date("2026-10-28T10:00:00.000Z");

async function eventually(assertion: () => Promise<void> | void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await assertion(); return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError;
}

describe("plugin job shutdown start boundary", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-job-shutdown-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values({
      id: PLUGIN_ID, pluginKey: "fixture.jobs", packageName: "@fixture/jobs", version: "1.0.0",
      manifestJson: {} as never, status: "ready",
    });
    await db.insert(pluginJobs).values({
      id: JOB_ID, pluginId: PLUGIN_ID, jobKey: "publish", schedule: "0 * * * *", nextRunAt: DUE,
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginJobRuns);
    await db.update(pluginJobs).set({ status: "active", lastRunAt: null, nextRunAt: DUE })
      .where(eq(pluginJobs.id, JOB_ID));
  });

  function fixture(call = vi.fn().mockResolvedValue({})) {
    const lifecycle = createRuntimeExecutionLifecycle();
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: pluginJobStore(db),
      workerManager: { isRunning: vi.fn(() => true), call } as never,
      runtimeLifecycle: lifecycle,
    });
    return { call, lifecycle, scheduler };
  }

  it("keeps a due scheduled run queued when shutdown wins before RPC start", async () => {
    const { call, lifecycle, scheduler } = fixture();
    lifecycle.beginShutdown("SIGTERM");

    await scheduler.tick();

    expect(call).not.toHaveBeenCalled();
    expect(await db.select().from(pluginJobRuns)).toMatchObject([
      { jobId: JOB_ID, trigger: "schedule", status: "queued", startedAt: null, finishedAt: null },
    ]);
    expect((await db.select().from(pluginJobs).where(eq(pluginJobs.id, JOB_ID)))[0]!.nextRunAt).toEqual(DUE);
  });

  it("finishes and records a scheduled RPC that started before shutdown", async () => {
    let finish!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const call = vi.fn(() => { signalStarted(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const { lifecycle, scheduler } = fixture(call);
    const pending = scheduler.tick();
    await started;
    expect(call).toHaveBeenCalledTimes(1);

    lifecycle.beginShutdown("SIGTERM");
    finish();
    await pending;

    expect(await db.select().from(pluginJobRuns)).toMatchObject([{ status: "succeeded" }]);
    expect((await db.select().from(pluginJobs).where(eq(pluginJobs.id, JOB_ID)))[0]!.nextRunAt)
      .not.toEqual(DUE);
  });

  it("replays one queued run once across concurrent plugin registration", async () => {
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    const { call, scheduler } = fixture();

    await Promise.all([scheduler.registerPlugin(PLUGIN_ID), scheduler.registerPlugin(PLUGIN_ID)]);

    expect(call).toHaveBeenCalledTimes(1);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "succeeded" });
  });

  it("leaves a manual request queued for restart instead of recording failure", async () => {
    const { call, lifecycle, scheduler } = fixture();
    lifecycle.beginShutdown("SIGTERM");

    const { runId } = await scheduler.triggerJob(JOB_ID);
    expect(scheduler.diagnostics().activeJobCount).toBe(1);
    await eventually(() => {
      expect(scheduler.diagnostics().activeJobCount).toBe(0);
    });
    await eventually(async () => {
      expect(await pluginJobStore(db).getRunById(runId)).toMatchObject({ status: "queued", startedAt: null });
    });

    expect(call).not.toHaveBeenCalled();
  });
});
