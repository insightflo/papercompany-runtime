import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  companySkills,
  companySecrets,
  activityLog,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missionSessions,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-recovery-"));
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

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunStatus(
  db: ReturnType<typeof createDb>,
  runId: string,
  status: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
}

describe("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const childProcesses = new Set<ChildProcess>();
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missionSessions);
    await db.delete(missions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    runningProcesses.clear();
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    updatedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: input?.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: input?.updatedAt ?? new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("terminates a detached recorded pid when cancelling the run", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);

    expect(cancelled?.status).toBe("cancelled");
    expect(await waitForPidExit(child.pid as number)).toBe(true);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not reap a running run that reported recent activity", async () => {
    const { runId, wakeupRequestId } = await seedRunFixture({
      includeIssue: false,
      updatedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("preserves issue linkage from heartbeatRuns.issueId even when the original context snapshot omits issueId", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      includeIssue: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover local adapter after lost process",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });
    await db
      .update(heartbeatRuns)
      .set({ issueId })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.issueId).toBe(issueId);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      retryOfRunId: runId,
      wakeReason: "process_lost_retry",
    });
  });

  it("restores mission and workflow run context on process-loss retry from the issue graph", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Workflow mission",
      status: "active",
    });
    await db.update(issues).set({ missionId }).where(eq(issues.id, issueId));
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "daily-news",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      status: "running",
      triggeredBy: "test",
      startedAt: new Date(),
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "validate-note",
      issueId,
      status: "running",
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      missionId,
      workflowRunId,
      workflowStepId: "validate-note",
      stepId: "validate-note",
      retryOfRunId: runId,
      wakeReason: "process_lost_retry",
    });
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.status).toBe("blocked");
  });

  it("queues an adapter fallback run after process-loss retry is exhausted", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
      adapterConfig: {
        command: "primary-agent",
        fallbackCommand: "fallback-agent",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const fallbackRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(fallbackRun?.status).toBe("queued");
    expect(fallbackRun?.retryOfRunId).toBe(runId);
    expect(fallbackRun?.processLossRetryCount).toBe(1);
    expect(fallbackRun?.contextSnapshot).toMatchObject({
      issueId,
      fallbackOfRunId: runId,
      fallbackReason: "process_lost",
      fallbackAttempt: 1,
      fallbackCommand: "fallback-agent",
      wakeReason: "adapter_fallback",
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(fallbackRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
    expect(issue?.status).toBe("in_progress");
  });

  it("executes queued adapter fallback runs with the fallback command", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const fallbackRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-fallback-bin-"));
    tempDirs.add(binDir);
    const primaryCommand = path.join(binDir, "primary.js");
    const fallbackCommand = path.join(binDir, "fallback.js");
    fs.writeFileSync(primaryCommand, "#!/usr/bin/env node\nprocess.exit(99);\n", "utf8");
    fs.writeFileSync(fallbackCommand, "#!/usr/bin/env node\nconsole.log('fallback ran');\n", "utf8");
    fs.chmodSync(primaryCommand, 0o755);
    fs.chmodSync(fallbackCommand, 0o755);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Runner",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: primaryCommand,
        fallbackCommand,
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      errorCode: "process_lost",
      error: "Process lost",
      processLossRetryCount: 1,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "adapter_fallback",
      payload: { fallbackOfRunId: failedRunId, fallbackReason: "process_lost" },
      status: "queued",
      runId: fallbackRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: fallbackRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      retryOfRunId: failedRunId,
      contextSnapshot: {
        retryOfRunId: failedRunId,
        fallbackOfRunId: failedRunId,
        fallbackReason: "process_lost",
        fallbackAttempt: 1,
        fallbackCommand,
        wakeReason: "adapter_fallback",
      },
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const completed = await waitForRunStatus(db, fallbackRunId, "succeeded");
    expect(completed?.status).toBe("succeeded");

    const invokeEvent = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, fallbackRunId))
      .then((rows) => rows.find((row) => row.eventType === "adapter.invoke") ?? null);
    expect(invokeEvent?.payload).toMatchObject({
      command: fallbackCommand,
    });
    expect(JSON.stringify(invokeEvent?.payload)).not.toContain(primaryCommand);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("expires queued heartbeat runs that exceed an explicit queued staleness threshold", async () => {
    const { runId, issueId, wakeupRequestId } = await seedRunFixture({
      runStatus: "queued",
    });
    await db
      .update(heartbeatRuns)
      .set({
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 5 * 60 * 1000 });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("stale_queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("failed");
  });
});
