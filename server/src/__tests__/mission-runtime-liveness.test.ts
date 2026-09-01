import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  companies,
  heartbeatRuns,
  issues,
  missionAgentRuntimes,
  missions,
} from "@paperclipai/db";
import { mapRuntimeLivenessToGovernanceEvents } from "../services/missions/governance-thread.ts";
import { listMissionExecutionSourceSnapshots } from "../services/missions/mission-execution-sources.ts";
import { MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT } from "../services/missions/mission-runtime-manager.ts";
import type { MissionRuntimeLivenessEntry } from "../services/missions/mission-execution-sources.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-liveness-"));
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

function makeEntry(overrides: Partial<MissionRuntimeLivenessEntry>): MissionRuntimeLivenessEntry {
  return {
    runtimeId: randomUUID(),
    agentId: randomUUID(),
    agentName: "Inspector",
    adapterType: "pi_local",
    workspaceKey: "default",
    status: "busy",
    currentIssueId: randomUUID(),
    currentIssueIdentifier: "RES-4418",
    runCount: 2,
    lastRunStatus: "succeeded",
    lastError: null,
    busySinceMs: 10 * 60 * 1000,
    backingRun: null,
    staleBusy: false,
    ...overrides,
  };
}

describe("runtime liveness governance events (pure mapper)", () => {
  const ctx = { missionId: randomUUID(), companyId: randomUUID() };

  it("busy with a backing run emits an in-flight info event that forbids PID-based death diagnosis", () => {
    const events = mapRuntimeLivenessToGovernanceEvents(makeEntry({
      backingRun: {
        id: randomUUID(),
        status: "running",
        issueId: null,
        startedAt: new Date(Date.now() - 14 * 60 * 1000),
        updatedAt: new Date(Date.now() - 30 * 1000),
        elapsedMs: 14 * 60 * 1000,
        idleMs: 30 * 1000,
      },
    }), ctx);

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("runtime_busy");
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.scope.heartbeatRunId).toBeTruthy();
    expect(events[0]!.summary).toContain("정상 대기");
    expect(events[0]!.summary).toContain("사망 판단 근거가 아니다");
    expect(events[0]!.sourceRef.type).toBe("mission_agent_runtime");
  });

  it("stale busy without a backing run emits an attention event pointing at the reaper", () => {
    const events = mapRuntimeLivenessToGovernanceEvents(makeEntry({
      staleBusy: true,
      busySinceMs: 9 * 60 * 1000,
    }), ctx);

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("runtime_stale_busy");
    expect(events[0]!.severity).toBe("attention");
    expect(events[0]!.summary).toContain("회수기");
  });

  it("emits nothing for idle runtimes and busy runtimes inside the grace window", () => {
    expect(mapRuntimeLivenessToGovernanceEvents(makeEntry({ status: "idle" }), ctx)).toHaveLength(0);
    expect(mapRuntimeLivenessToGovernanceEvents(makeEntry({
      backingRun: null,
      staleBusy: false,
      busySinceMs: 60 * 1000,
    }), ctx)).toHaveLength(0);
  });
});

describe("runtime liveness snapshot (embedded PG)", () => {
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

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "liveness-co" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Liveness Agent", adapterType: "pi_local" });
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      title: "liveness-mission",
      status: "active",
      ownerAgentId: agentId,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "RES-9999",
      title: "liveness-issue",
      status: "in_progress",
      priority: 2,
    });
    return { companyId, agentId, missionId, issueId };
  }

  const now = new Date("2026-09-01T10:00:00.000Z");
  const staleUpdated = new Date(now.getTime() - MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT - 60_000);

  it("reports backing run detail for a busy runtime with a live run", async () => {
    const ctx = await seed();
    await db.insert(missionAgentRuntimes).values({
      id: randomUUID(),
      companyId: ctx.companyId,
      missionId: ctx.missionId,
      agentId: ctx.agentId,
      adapterType: "pi_local",
      runtimeKey: "rk-1",
      status: "busy",
      currentIssueId: ctx.issueId,
      workspaceKey: "default",
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "running",
      issueId: ctx.issueId,
      startedAt: new Date(now.getTime() - 9 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 20 * 1000),
    });

    const snapshots = await listMissionExecutionSourceSnapshots(db, { companyId: ctx.companyId, missionIds: [ctx.missionId], now });
    const runtimes = snapshots[ctx.missionId]?.runtimes ?? [];
    expect(runtimes).toHaveLength(1);
    const entry = runtimes[0]!;
    expect(entry.agentName).toBe("Liveness Agent");
    expect(entry.currentIssueIdentifier).toBe("RES-9999");
    expect(entry.backingRun?.id).toBe(runId);
    expect(entry.backingRun?.status).toBe("running");
    expect(Math.round(entry.backingRun!.elapsedMs / 60000)).toBe(9);
    expect(entry.staleBusy).toBe(false);

    const events = mapRuntimeLivenessToGovernanceEvents(entry, { missionId: ctx.missionId, companyId: ctx.companyId, now });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("runtime_busy");
  });

  it("flags stale busy when no run backs the runtime past the grace window", async () => {
    const ctx = await seed();
    await db.insert(missionAgentRuntimes).values({
      id: randomUUID(),
      companyId: ctx.companyId,
      missionId: ctx.missionId,
      agentId: ctx.agentId,
      adapterType: "pi_local",
      runtimeKey: "rk-2",
      status: "busy",
      currentIssueId: ctx.issueId,
      workspaceKey: "default",
      updatedAt: staleUpdated,
    });

    const snapshots = await listMissionExecutionSourceSnapshots(db, { companyId: ctx.companyId, missionIds: [ctx.missionId], now });
    const entry = snapshots[ctx.missionId]!.runtimes[0]!;
    expect(entry.backingRun).toBeNull();
    expect(entry.staleBusy).toBe(true);

    const events = mapRuntimeLivenessToGovernanceEvents(entry, { missionId: ctx.missionId, companyId: ctx.companyId, now });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("runtime_stale_busy");
    expect(events[0]!.severity).toBe("attention");
  });
});
