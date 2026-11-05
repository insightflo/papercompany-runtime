import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createDb, pluginJobRuns, pluginJobs, pluginWebhookDeliveries, plugins,
  startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { pluginJobRunStore } from "../services/plugin-job-run-store.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { withPluginPurgeGuard } from "../services/plugin-purge-guard.js";
import { ingestWebhookDelivery } from "../services/plugin-webhook-receipt.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db, peer: Db, purger: Db;
const clients: Db[] = [];

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("plugin-purge-guard-");
  const connect = () => { const client = createDb(database.connectionString); clients.push(client); return client; };
  db = connect(); peer = connect(); purger = connect();
  const [a] = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
  const [b] = await peer.execute(sql`SELECT pg_backend_pid() AS pid`);
  expect(Number(a!.pid)).not.toBe(Number(b!.pid));
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.$client.end({ timeout: 5 })));
  await database?.cleanup();
});

async function seedPlugin(client: Db = db) {
  const key = randomUUID();
  const [row] = await client.insert(plugins).values({
    pluginKey: key, packageName: key, version: "1.0.0", manifestJson: {} as never,
  }).returning();
  return row!;
}

async function seedJob(pluginId: string, client: Db = db) {
  const [row] = await client.insert(pluginJobs).values({
    pluginId, jobKey: randomUUID(), schedule: "* * * * *",
  }).returning();
  return row!;
}

type RunInput = {
  id?: string; jobId: string; pluginId: string; status?: string; trigger?: string;
  createdAt?: Date; finishedAt?: Date; startedAt?: Date; completionUncertainty?: string;
  claimToken?: string; scheduledAt?: Date; scheduledCron?: string;
};

async function seedRun(input: RunInput, client: Db = db) {
  const [row] = await client.insert(pluginJobRuns).values({
    ...(input.id ? { id: input.id } : {}),
    jobId: input.jobId, pluginId: input.pluginId,
    status: (input.status ?? "queued") as never, trigger: (input.trigger ?? "manual") as never,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completionUncertainty ? { completionUncertainty: input.completionUncertainty as never } : {}),
    ...(input.claimToken ? { claimToken: input.claimToken } : {}),
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.scheduledCron ? { scheduledCron: input.scheduledCron } : {}),
  }).returning();
  return row!;
}

async function seedReceipt(pluginId: string, status: string, finishedAt?: Date, client: Db = db, externalId?: string, webhookKey = randomUUID()) {
  const [row] = await client.insert(pluginWebhookDeliveries).values({
    pluginId, webhookKey, status: status as never, payload: {}, ...(externalId ? { externalId } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  }).returning();
  return row!;
}

async function refused(operation: () => Promise<unknown>, reason: string) {
  await expect(operation()).rejects.toMatchObject({
    name: "PluginPurgeConflict", code: "PLUGIN_PURGE_CONFLICT",
    details: reason === "lock_not_available" ? { reason, sqlState: "55P03" } : { reason },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdJob(jobId: string) {
  const locked = deferred(), release = deferred();
  const done = peer.transaction(async (tx) => {
    await tx.select({ id: pluginJobs.id }).from(pluginJobs).where(eq(pluginJobs.id, jobId)).for("update");
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  return { done, release: () => release.resolve() };
}
async function waitForBlockedJobLock(observer: Db) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await observer.execute(sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE '%plugin_jobs%' AND query ILIKE '%FOR UPDATE%'`);
    if (waiting.length > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("plugin job operation did not reach the held row lock");
}

describe("plugin purge protection on isolated PostgreSQL", () => {
  it("rejects accepted, running, uncertain, unknown, and incompletely finalized runs through both entry points", async () => {
    const cases: RunInput[] = [
      { status: "queued", trigger: "manual" }, { status: "queued", trigger: "retry" },
      { status: "queued", trigger: "schedule", scheduledAt: new Date(), scheduledCron: "* * * * *" },
      { status: "pending" }, { status: "running", startedAt: new Date(), claimToken: randomUUID() },
      { status: "succeeded" },
      { status: "failed", finishedAt: new Date(), completionUncertainty: "external_execution_sent_or_unknown" },
      { status: "future_status", finishedAt: new Date() },
    ];
    for (const bad of cases) {
      const plugin = await seedPlugin(), job = await seedJob(plugin.id);
      const old = new Date("2001-01-01T00:00:00.000Z"), fresh = new Date("2040-01-01T00:00:00.000Z");
      await seedRun({ jobId: job.id, pluginId: plugin.id, status: "succeeded", finishedAt: old, createdAt: old });
      const protectedRun = await seedRun({ ...bad, jobId: job.id, pluginId: plugin.id });
      await seedRun({ jobId: job.id, pluginId: plugin.id, status: "cancelled", finishedAt: fresh, createdAt: fresh });
      await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "protected_job_run");
      await refused(() => pluginJobStore(purger).deleteAllJobs(plugin.id), "protected_job_run");
      expect(await pluginRegistryService(db).getById(plugin.id)).not.toBeNull();
      expect(await pluginJobStore(db).getJobById(job.id)).not.toBeNull();
      expect(await pluginJobRunStore(db).getRunById(protectedRun.id)).not.toBeNull();
    }
  });

  it("uses the exact cascade union and leaves protected work for other plugins alone", async () => {
    const a = await seedPlugin(), b = await seedPlugin(), idle = await seedPlugin();
    const ja = await seedJob(a.id), jb = await seedJob(b.id), ji = await seedJob(idle.id);
    const crossedByJob = await seedRun({ jobId: ja.id, pluginId: b.id, status: "queued" });
    const crossedByPlugin = await seedRun({ jobId: jb.id, pluginId: a.id, status: "pending" });
    await refused(() => pluginJobStore(purger).deleteAllJobs(a.id), "protected_job_run");
    await refused(() => pluginJobStore(purger).deleteAllJobs(b.id), "protected_job_run");
    await refused(() => pluginRegistryService(purger).uninstall(a.id, true), "protected_job_run");
    await refused(() => pluginRegistryService(purger).uninstall(b.id, true), "protected_job_run");
    expect(await pluginJobRunStore(db).getRunById(crossedByJob.id)).not.toBeNull();
    expect(await pluginJobRunStore(db).getRunById(crossedByPlugin.id)).not.toBeNull();
    const idleHardDelete = await seedPlugin();
    await pluginRegistryService(purger).uninstall(idleHardDelete.id, true);
    expect(await pluginRegistryService(db).getById(idleHardDelete.id)).toBeNull();
    await pluginJobStore(purger).deleteAllJobs(idle.id);
    expect(await pluginJobStore(db).getJobById(ji.id)).toBeNull();
    expect(await pluginJobRunStore(db).getRunById(crossedByJob.id)).not.toBeNull();
  });

  it("allows empty and positively terminal purges while soft and job-only deletion preserve their scope", async () => {
    const empty = await seedPlugin();
    await pluginRegistryService(purger).uninstall(empty.id, true);
    expect(await pluginRegistryService(db).getById(empty.id)).toBeNull();
    const terminal = await seedPlugin(), job = await seedJob(terminal.id);
    await seedRun({ jobId: job.id, pluginId: terminal.id, status: "cancelled", finishedAt: new Date() });
    await seedReceipt(terminal.id, "success", new Date());
    await seedReceipt(terminal.id, "failed", new Date());
    await pluginRegistryService(purger).uninstall(terminal.id, true);
    expect(await pluginRegistryService(db).getById(terminal.id)).toBeNull();

    const kept = await seedPlugin(), keptJob = await seedJob(kept.id);
    const run = await seedRun({ jobId: keptJob.id, pluginId: kept.id, status: "queued" });
    const receipt = await seedReceipt(kept.id, "pending");
    await pluginRegistryService(purger).uninstall(kept.id, false);
    expect(await pluginRegistryService(db).getById(kept.id)).toMatchObject({ status: "uninstalled" });
    expect(await pluginJobRunStore(db).getRunById(run.id)).not.toBeNull();
    expect(await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.id, receipt.id))).toHaveLength(1);
    const jobsOnly = await seedPlugin(), jobsOnlyJob = await seedJob(jobsOnly.id);
    await seedRun({ jobId: jobsOnlyJob.id, pluginId: jobsOnly.id, status: "succeeded", finishedAt: new Date() });
    const unrelatedReceipt = await seedReceipt(jobsOnly.id, "pending");
    await pluginJobStore(purger).deleteAllJobs(jobsOnly.id);
    expect(await pluginJobStore(db).getJobById(jobsOnlyJob.id)).toBeNull();
    expect(await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.id, unrelatedReceipt.id))).toHaveLength(1);
  });

  it("rejects unfinished webhooks and NOWAIT-refuses a failed-receipt retry reopening", async () => {
    for (const [status, finishedAt] of [["pending", undefined], ["processing", undefined], ["future", new Date()], ["success", undefined]] as const) {
      const plugin = await seedPlugin();
      await seedReceipt(plugin.id, status, finishedAt);
      await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "protected_webhook");
    }

    const plugin = await seedPlugin(), receipt = await seedReceipt(plugin.id, "failed", new Date(), db, "delivery-1", "retry-hook");
    const entered = deferred(), release = deferred();
    const retry = peer.transaction(async (tx) => {
      await tx.update(pluginWebhookDeliveries).set({ status: "pending", finishedAt: null })
        .where(eq(pluginWebhookDeliveries.id, receipt.id));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "lock_not_available");
      expect(await pluginRegistryService(db).getById(plugin.id)).not.toBeNull();
    } finally { release.resolve(); await retry; }
    expect(await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.id, receipt.id)))
      .toMatchObject([{ status: "pending" }]);
    await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "protected_webhook");
    const call = vi.fn(async () => undefined);
    const duplicate = await ingestWebhookDelivery(db, { call } as never, { pluginId: plugin.id, endpointKey: "retry-hook",
      headers: { "x-delivery-id": "delivery-1" }, reqHeaders: {}, rawBody: "{}", parsedBody: {}, payload: { deliveryId: "delivery-1" } });
    expect([duplicate.body.status, call.mock.calls.length]).toEqual(["duplicate", 0]);
  });

  it("NOWAIT-locks crossed finished runs in ID order before either hard purge cascades", async () => {
    const a = await seedPlugin(), b = await seedPlugin(), outside = await seedPlugin();
    const ja = await seedJob(a.id), jb = await seedJob(b.id), jc = await seedJob(outside.id);
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    await seedRun({ id: ids[0], jobId: ja.id, pluginId: b.id, status: "succeeded", finishedAt: new Date() });
    await seedRun({ id: ids[1], jobId: jb.id, pluginId: a.id, status: "failed", finishedAt: new Date() });
    const unrelated = await seedRun({ jobId: jc.id, pluginId: outside.id, status: "running" });
    const locked = deferred(), release = deferred();
    const first = withPluginPurgeGuard(db, {
      pluginId: a.id, mode: "plugin", delete: async (tx) => {
        const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        const [peerPid] = await purger.execute(sql`SELECT pg_backend_pid() AS pid`);
        expect(Number(pid!.pid)).not.toBe(Number(peerPid!.pid));
        locked.resolve();
        await release.promise;
        return (await tx.delete(plugins).where(eq(plugins.id, a.id)).returning())[0];
      },
    });
    await locked.promise;
    try {
      await refused(() => pluginRegistryService(purger).uninstall(b.id, true), "lock_not_available");
      expect(await pluginRegistryService(db).getById(b.id)).not.toBeNull();
      expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, ids[0]))).toHaveLength(1);
      expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, ids[1]))).toHaveLength(1);
    }
    finally { release.resolve(); }
    await first;
    expect(await pluginRegistryService(db).getById(b.id)).not.toBeNull();
    await pluginRegistryService(purger).uninstall(b.id, true);
    expect(await pluginRegistryService(db).getById(outside.id)).not.toBeNull();
    expect(await pluginJobRunStore(db).getRunById(unrelated.id)).not.toBeNull();
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, ids[0]))).toHaveLength(0);
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, ids[1]))).toHaveLength(0);
  });

  it("releases a failed purge so admission, claim, and finalization can use the same rows once", async () => {
    const plugin = await seedPlugin(), job = await seedJob(plugin.id);
    await db.update(pluginJobs).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(pluginJobs.id, job.id));
    const admissionHold = await holdJob(job.id);
    try { await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "lock_not_available"); }
    finally { admissionHold.release(); await admissionHold.done; }
    const runStore = pluginJobRunStore(db);
    const admitted = await runStore.createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: plugin.id });
    expect(admitted.kind).toBe("available");
    if (admitted.kind !== "available") throw new Error("scheduled admission did not resume");

    const claimHold = await holdJob(job.id), claimPromise = runStore.claimQueuedRun(admitted.run.id);
    claimPromise.catch(() => undefined);
    try {
      await waitForBlockedJobLock(peer);
      await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "lock_not_available");
    } finally { claimHold.release(); await claimHold.done; }
    const claim = await claimPromise;
    expect(claim).toMatchObject({ id: admitted.run.id, status: "running" });
    if (!claim?.claimToken) throw new Error("claim token missing");
    const send = vi.fn(); send(claim.id);
    const finalizeHold = await holdJob(job.id), finalizePromise = runStore.finalizeClaimedRun(claim.id, claim.claimToken, { status: "succeeded" });
    finalizePromise.catch(() => undefined);
    try {
      await waitForBlockedJobLock(peer);
      await refused(() => pluginRegistryService(purger).uninstall(plugin.id, true), "lock_not_available");
    } finally { finalizeHold.release(); await finalizeHold.done; }
    expect(await finalizePromise).toBe("finalized");
    expect(await runStore.finalizeClaimedRun(claim.id, claim.claimToken, { status: "succeeded" })).toBe("already_finalized");
    const duplicateClaim = await runStore.claimQueuedRun(claim.id);
    if (duplicateClaim) send(duplicateClaim.id);
    expect(send).toHaveBeenCalledOnce();
    expect(await pluginJobRunStore(db).getRunById(claim.id)).toMatchObject({ status: "succeeded", completionUncertainty: null });
  });

  it("does not accept admission or a claim after a purge owns and deletes their target rows", async () => {
    const plugin = await seedPlugin(), job = await seedJob(plugin.id);
    await db.update(pluginJobs).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(pluginJobs.id, job.id));
    const locked = deferred(), release = deferred();
    const purge = withPluginPurgeGuard(purger, {
      pluginId: plugin.id, mode: "plugin", delete: async (tx) => {
        locked.resolve();
        await release.promise;
        return (await tx.delete(plugins).where(eq(plugins.id, plugin.id)).returning())[0];
      },
    });
    await locked.promise;
    const admission = pluginJobRunStore(db).createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: plugin.id });
    admission.catch(() => undefined);
    try { await waitForBlockedJobLock(peer); }
    finally { release.resolve(); }
    await purge;
    await expect(admission).rejects.toMatchObject({ status: 404 });
    expect(await pluginJobRunStore(db).claimQueuedRun(randomUUID())).toBeNull();
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.pluginId, plugin.id))).toHaveLength(0);
  });
});
