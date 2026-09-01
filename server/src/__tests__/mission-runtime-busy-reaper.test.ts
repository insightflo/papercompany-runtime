import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issues,
  missionAgentRuntimes,
  missions,
  agents,
} from "@paperclipai/db";
import {
  MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT,
  reapStaleBusyMissionRuntimes,
} from "../services/missions/mission-runtime-manager.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-busy-reaper-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

describe("mission runtime stale-busy reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(missionAgentRuntimes);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client?.end();
    await instance?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  async function seed(opts?: { missionStatus?: string }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "reap-test-co" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "reap-agent",
      adapterType: "pi_local",
    });
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      title: "reap-mission",
      status: opts?.missionStatus ?? "active",
      ownerAgentId: agentId,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "reap-issue",
      status: "in_progress",
      priority: 2,
    });
    return { companyId, agentId, missionId, issueId };
  }

  async function insertRuntime(input: {
    companyId: string;
    missionId: string;
    agentId: string;
    currentIssueId: string | null;
    updatedAt: Date;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(missionAgentRuntimes).values({
      id,
      companyId: input.companyId,
      missionId: input.missionId,
      agentId: input.agentId,
      adapterType: "pi_local",
      runtimeKey: `company:${input.companyId}|mission:${input.missionId}|agent:${input.agentId}|adapter:pi_local|workspace:default`,
      status: input.status ?? "busy",
      currentIssueId: input.currentIssueId,
      workspaceKey: "default",
      updatedAt: input.updatedAt,
    });
    return id;
  }

  const graceMs = 5 * 60 * 1000;
  const now = new Date("2026-09-01T09:30:00.000Z");
  const staleUpdated = new Date(now.getTime() - graceMs - 60_000);
  const freshUpdated = new Date(now.getTime() - 30_000);

  it("reaps a stale busy runtime with no backing run and reports the wakeup callback", async () => {
    const ctx = await seed();
    const runtimeId = await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: staleUpdated });
    const onReaped: Array<{ agentId: string; issueId: string | null }> = [];

    const summary = await reapStaleBusyMissionRuntimes(db, {
      now,
      graceMs,
      onReaped: async (reaped) => {
        onReaped.push({ agentId: reaped.agentId, issueId: reaped.issueId });
      },
    });

    expect(summary.reaped).toHaveLength(1);
    expect(summary.reaped[0]!.runtimeId).toBe(runtimeId);
    expect(onReaped).toEqual([{ agentId: ctx.agentId, issueId: ctx.issueId }]);

    const [row] = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.id, runtimeId));
    expect(row?.status).toBe("idle");
    expect(row?.currentIssueId).toBeNull();
    expect(row?.lastError).toContain("stale_busy_reaped");
    expect(row?.stateJson.busyReaper?.previousCurrentIssueId).toBe(ctx.issueId);
    expect(row?.stateJson.busyReaper?.previousStatus).toBe("busy");
  });

  it("does not reap when a running heartbeat run backs the busy state (same issue)", async () => {
    const ctx = await seed();
    const runtimeId = await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: staleUpdated });
    await db.insert(heartbeatRuns).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "running",
      issueId: ctx.issueId,
      updatedAt: now,
    });

    const summary = await reapStaleBusyMissionRuntimes(db, { now, graceMs });
    expect(summary.reaped).toHaveLength(0);
    expect(summary.skippedActiveRun).toBe(1);

    const [row] = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.id, runtimeId));
    expect(row?.status).toBe("busy");
  });

  it("does not reap when a queued heartbeat run backs the busy state (same issue)", async () => {
    const ctx = await seed();
    await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: staleUpdated });
    await db.insert(heartbeatRuns).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "queued",
      issueId: ctx.issueId,
      updatedAt: now,
    });

    const summary = await reapStaleBusyMissionRuntimes(db, { now, graceMs });
    expect(summary.reaped).toHaveLength(0);
    expect(summary.skippedActiveRun).toBe(1);
  });

  it("does not reap a sibling-mission-issue run of the same agent as backing activity", async () => {
    const ctx = await seed();
    await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: staleUpdated });
    const siblingIssueId = randomUUID();
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId: ctx.companyId,
      missionId: ctx.missionId,
      title: "sibling-issue",
      status: "in_progress",
      priority: 2,
    });
    await db.insert(heartbeatRuns).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "running",
      issueId: siblingIssueId,
      updatedAt: now,
    });

    const summary = await reapStaleBusyMissionRuntimes(db, { now, graceMs });
    expect(summary.reaped).toHaveLength(0);
    expect(summary.skippedActiveRun).toBe(1);
  });

  it("does not reap within the grace window (dispatch-prep protection)", async () => {
    const ctx = await seed();
    await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: freshUpdated });

    const summary = await reapStaleBusyMissionRuntimes(db, { now, graceMs });
    expect(summary.reaped).toHaveLength(0);
  });

  it("reaps but skips the wakeup callback for a terminal mission", async () => {
    const ctx = await seed({ missionStatus: "completed" });
    await insertRuntime({ ...ctx, currentIssueId: ctx.issueId, updatedAt: staleUpdated });
    const onReaped: unknown[] = [];

    const summary = await reapStaleBusyMissionRuntimes(db, {
      now,
      graceMs,
      onReaped: async () => {
        onReaped.push(1);
      },
    });

    expect(summary.reaped).toHaveLength(1);
    expect(summary.skippedTerminalMission).toBe(1);
    expect(onReaped).toHaveLength(0);
  });

  it("uses the documented default grace", () => {
    expect(MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT).toBe(5 * 60 * 1000);
  });
});
