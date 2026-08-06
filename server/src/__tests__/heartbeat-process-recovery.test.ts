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
  agentWikiEntries,
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
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";

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
    // fire-and-forget wiki hooks(recordFailure)가 비동기 — cleanup delete 전에 settle해서
    // company/agent 삭제 후 늦은 insert가 도착해 agent_wiki_entries FK error가 나는 race를 방지.
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await db.delete(agentWikiEntries);
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
    processStartedAt?: Date | null;
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
      processStartedAt: input?.processStartedAt ?? null,
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
      processStartedAt: new Date(),
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

  it("force-reaps a detached local run whose child has run past the detached cap", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      // 45분 전 시작 — DETACHED_REAP_AFTER_MS(30분) 초과 → cap 발동해 process_lost 회수
      processStartedAt: new Date(Date.now() - 45 * 60 * 1000),
      processLossRetryCount: 1,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("records a process_lost wiki entry when a detached run is force-reaped", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const seeded = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(Date.now() - 45 * 60 * 1000), // > 30min cap → process_lost
      processLossRetryCount: 1,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();
    // fireWikiRecord is non-blocking — let the recordFailure insert settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const entries = await db
      .select()
      .from(agentWikiEntries)
      .where(eq(agentWikiEntries.agentId, seeded.agentId));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.errorCode).toBe("process_lost");
    expect(entries[0]?.pattern).toContain("process_lost");
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
  it("terminalizes an active linked run immediately when an issue is marked done", async () => {
    const { companyId, runId, wakeupRequestId, issueId } = await seedRunFixture();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId,
      companyId,
      status: "done",
      linkedRunIds: [runId],
    });

    expect(result).toEqual({ finalized: 1, runIds: [runId] });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toEqual(expect.objectContaining({
      status: "succeeded",
      errorCode: null,
      error: null,
      finishedAt: expect.any(Date),
    }));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toEqual(expect.objectContaining({
      status: "completed",
      finishedAt: expect.any(Date),
    }));
  });

  it("terminalizes an active linked run as failed when an issue is marked blocked", async () => {
    const { companyId, runId, wakeupRequestId, issueId } = await seedRunFixture();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId,
      companyId,
      status: "blocked",
      linkedRunIds: [runId],
    });

    expect(result).toEqual({ finalized: 1, runIds: [runId] });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "issue_status_blocked",
      finishedAt: expect.any(Date),
    }));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toEqual(expect.objectContaining({
      status: "failed",
      finishedAt: expect.any(Date),
    }));
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

    const commentBody = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.map((row) => row.body).join("\n"));
    expect(commentBody).toContain("복구 상태: process_lost retry 1/1, adapter fallback 0회 시도됨");
    expect(commentBody).toContain("자동 retry 한도를 소진");
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

  it("expires a stale queued run even while the same agent is still running another run (B2)", async () => {
    // [paperclip-stuck 2026-08-06, B2] Previously a single running run caused the stale
    // check for every queued run of that agent to be skipped (hasRunningRunForAgent guard),
    // so with maxConcurrentRuns=1 one phantom running run blocked all queued runs forever.
    // Stale detection is now independent of whether a running run exists: a queued run past
    // queuedStaleThresholdMs is recorded as failed (stale_queued) regardless. Promotion still
    // respects the concurrency slot, so only genuinely-stale queued runs are affected.
    const { companyId, agentId, runId: runningRunId } = await seedRunFixture({
      includeIssue: false,
      updatedAt: new Date(),
    });
    const queuedRunId = randomUUID();
    const queuedWakeupId = randomUUID();
    const staleAt = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "pending",
      runId: queuedRunId,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: {},
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    await db
      .update(heartbeatRuns)
      .set({ startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runningRunId));
    const child = spawnAliveProcess();
    childProcesses.add(child);
    runningProcesses.set(runningRunId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 5 * 60 * 1000 });
    // B2: the stale queued run is failed even though the agent still owns a running run.
    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(queuedRunId);

    const queuedRun = await heartbeat.getRun(queuedRunId);
    expect(queuedRun?.status).toBe("failed");
    expect(queuedRun?.errorCode).toBe("stale_queued");

    const queuedWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queuedWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(queuedWakeup?.status).toBe("failed");
  });

  it("does not expire a within-threshold queued run while the agent is running another run", async () => {
    // [B2 threshold guard] Removing the hasRunningRunForAgent guard must not make every
    // queued run eligible — only runs past queuedStaleThresholdMs. A freshly-queued run
    // sitting behind a running run must still be preserved (it is legitimately waiting).
    const { companyId, agentId, runId: runningRunId } = await seedRunFixture({
      includeIssue: false,
      updatedAt: new Date(),
    });
    const queuedRunId = randomUUID();
    const queuedWakeupId = randomUUID();
    const freshAt = new Date(); // within threshold

    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "pending",
      runId: queuedRunId,
      createdAt: freshAt,
      updatedAt: freshAt,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: {},
      createdAt: freshAt,
      updatedAt: freshAt,
    });
    const child = spawnAliveProcess();
    childProcesses.add(child);
    runningProcesses.set(runningRunId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 5 * 60 * 1000 });
    expect(result.reaped).toBe(0);

    const queuedRun = await heartbeat.getRun(queuedRunId);
    expect(queuedRun?.status).toBe("queued");
    expect(queuedRun?.errorCode).toBeNull();
  });

  it("expires stale agent_wakeup_requests rows that never created a heartbeat run (runId IS NULL, B1)", async () => {
    // [paperclip-stuck 2026-08-06, B1] The mission-dedup enqueue path persists an
    // agent_wakeup_requests row with status='queued' and runId=NULL but never creates a
    // heartbeat_runs row. The stale-queued reaper only inspected heartbeat_runs, so these
    // rows sat queued forever (5 of them in the incident). The reaper must now also fail
    // stale runId=NULL queued wakeup requests so callers can re-enqueue fresh requests.
    const { companyId, agentId } = await seedRunFixture({
      includeIssue: false,
      runStatus: "queued",
    });
    const orphanWakeupId = randomUUID();
    const staleAt = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: orphanWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "mission_owner_retry_source_issue",
      payload: {},
      status: "queued",
      runId: null,
      idempotencyKey: "mission-owner-plan-rework:abc:def",
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    // Make the seeded queued heartbeat run fresh so only the orphan wakeup is stale.
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 5 * 60 * 1000 });

    const orphanWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, orphanWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(orphanWakeup?.status).toBe("failed");
    expect(orphanWakeup?.error).toContain("stale_queued");
    expect(orphanWakeup?.finishedAt).toBeInstanceOf(Date);
    // The fresh seeded queued run is untouched.
    expect(result.reaped).toBe(0);
  });

  it("marks a failed mission_main_executor_unblock blocked without emitting a Human Operator request (boundary)", async () => {
    // [root-cause boundary] releaseIssueExecutionAndPromote marks a terminal failed/timed_out
    //   mission_main_executor_unblock issue blocked + generic run_failure_auto_blocked only. It must NOT
    //   itself emit the Human Operator request — that is supervision's job, gated on truly-terminal.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownerActionIssueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({ id: companyId, name: "Boundary Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Boundary mission", status: "active" });
    await db.insert(issues).values({
      id: sourceIssueId, companyId, missionId, identifier: `${issuePrefix}-1`, title: "Blocked source",
      status: "blocked", assigneeAgentId: workerAgentId, originKind: "workflow_execution",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId: ownerAgentId, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: ownerActionIssueId }, status: "claimed", runId, claimedAt: now,
    });
    const child = spawnAliveProcess();
    childProcesses.add(child);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: ownerAgentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", wakeupRequestId, contextSnapshot: { issueId: ownerActionIssueId, missionId },
      processPid: child.pid ?? null, processStartedAt: new Date(Date.now() - 45 * 60 * 1000),
      processLossRetryCount: 1, startedAt: now, updatedAt: now,
    });
    // owner-action issue references runId (checkout/execution) — insert after the run exists.
    await db.insert(issues).values({
      id: ownerActionIssueId, companyId, missionId, identifier: `${issuePrefix}-2`, title: "[Unblock] source",
      status: "in_progress", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, checkoutRunId: runId, executionRunId: runId,
    });
    child.kill("SIGKILL");
    await waitForPidExit(child.pid ?? null);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    const reapedRun = await heartbeat.getRun(runId);
    expect(reapedRun?.status).toBe("failed");

    const updatedOwnerAction = await db.select({ status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, ownerActionIssueId)).then((rows) => rows[0] ?? null);
    expect(updatedOwnerAction?.status).toBe("blocked");
    expect(updatedOwnerAction?.checkoutRunId).toBeNull();
    expect(updatedOwnerAction?.executionRunId).toBeNull();

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: ownerActionIssueId }),
      ]),
    );
    // heartbeat failure path must NOT create the Human Operator request — supervision owns that.
    const issueActivities = await db.select().from(activityLog).where(eq(activityLog.entityId, ownerActionIssueId));
    expect(issueActivities.some((row) => row.action === HUMAN_OPERATOR_REQUEST_ACTION)).toBe(false);
  });
  it("demotes a phantom-running agent to error while a detached child is deferred (A2)", async () => {
    // [paperclip-stuck 2026-08-06, A2] When the in-memory process handle is gone but the
    // recorded child pid is still alive, reapOrphanedRuns defers the run up to the 30min
    // detached cap. During that window finalizeAgentStatus is never called, so agents.status
    // was pinned at `running` (phantom running). Directly demote the agent to `error` once
    // it has been stuck detached beyond a shorter heartbeat threshold, even though the run
    // itself is intentionally left alive under the longevity cap.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleUpdatedAt = new Date(Date.now() - 15 * 60 * 1000); // > 10min demote threshold

    await db.insert(companies).values({
      id: companyId,
      name: "Phantom Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Phantom",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt: staleUpdatedAt,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: staleUpdatedAt,
    });
    const child = spawnAliveProcess();
    childProcesses.add(child);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: child.pid ?? null,
      processStartedAt: new Date(),
      processLossRetryCount: 0,
      startedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    // run is within the 30min cap → not reaped, stays running + detached.
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    // agent is no longer phantom-running: demoted to error.
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("error");
  });

  it("does not demote an agent that still has a genuinely-progressing (non-detached) run", async () => {
    // [A2 guard] A demote must never fire while a sibling run is making real progress. Here
    // the agent has one detached run AND one fresh non-detached running run → it stays running.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const detachedRunId = randomUUID();
    const progressingRunId = randomUUID();
    const detachedWakeupId = randomUUID();
    const progressingWakeupId = randomUUID();
    const issuePrefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleUpdatedAt = new Date(Date.now() - 15 * 60 * 1000);

    await db.insert(companies).values({ id: companyId, name: "Guard Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Guard", role: "engineer", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      updatedAt: staleUpdatedAt,
    });
    await db.insert(agentWakeupRequests).values([
      { id: detachedWakeupId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: {}, status: "claimed", runId: detachedRunId, claimedAt: staleUpdatedAt },
      { id: progressingWakeupId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: {}, status: "claimed", runId: progressingRunId, claimedAt: new Date() },
    ]);
    const child = spawnAliveProcess();
    childProcesses.add(child);
    // progressing run is genuinely tracked in-memory (live handle) → survives the reaper.
    const progressingChild = spawnAliveProcess();
    childProcesses.add(progressingChild);
    runningProcesses.set(progressingRunId, { child: progressingChild, graceSec: 1 });
    await db.insert(heartbeatRuns).values([
      {
        id: detachedRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", wakeupRequestId: detachedWakeupId, contextSnapshot: {},
        processPid: child.pid ?? null, processStartedAt: new Date(), processLossRetryCount: 0,
        startedAt: staleUpdatedAt, updatedAt: staleUpdatedAt,
      },
      {
        id: progressingRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", wakeupRequestId: progressingWakeupId, contextSnapshot: {},
        processPid: progressingChild.pid ?? null, processStartedAt: new Date(), processLossRetryCount: 0,
        startedAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    // sibling progressing run protects the agent from demotion.
    expect(agent?.status).toBe("running");
  });
});
