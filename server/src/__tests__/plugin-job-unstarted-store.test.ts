import {
  createDb,
  pluginJobRuns,
  pluginJobs,
  plugins,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pluginJobStore } from "../services/plugin-job-store.js";

const PLUGIN_ID = "5361684c-d394-4712-8998-e718ef682147";
const JOB_ID = "0c1feb0a-220f-44b6-a071-fc5b9b11b53b";

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
  });

  it("serializes scheduled admission and reuses one queued row", async () => {
    const store = pluginJobStore(db);
    const input = { jobId: JOB_ID, pluginId: PLUGIN_ID };
    const [first, second] = await Promise.all([
      store.createOrReuseQueuedScheduledRun(input),
      store.createOrReuseQueuedScheduledRun(input),
    ]);

    expect(first.run.id).toBe(second.run.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await db.select().from(pluginJobRuns)).toHaveLength(1);
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
    expect(await store.claimQueuedRun(run.id, at)).not.toBeNull();

    expect(await store.releaseUnstartedClaim(run.id, new Date(at.getTime() + 1))).toBe(false);
    expect(await store.releaseUnstartedClaim(run.id, at)).toBe(true);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
    expect(await store.claimQueuedRun(run.id, new Date(at.getTime() + 2))).not.toBeNull();
  });

  it("lists replayable queued rows oldest first without running rows", async () => {
    const store = pluginJobStore(db);
    const first = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    const second = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "retry" });
    await store.claimQueuedRun(first.id);

    await expect(store.listQueuedRunsByPlugin(PLUGIN_ID)).resolves.toMatchObject([{ id: second.id }]);
  });
});
