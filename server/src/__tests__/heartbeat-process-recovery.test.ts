import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  approvals,
  agents,
  agentRuntimeState,
  agentWikiEntries,
  companySkills,
  companySecrets,
  activityLog,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  heartbeatRuns,
  instanceSettings,
  issueApprovals, issues,
  issueComments,
  missionSessions,
  missions, operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService, setHeartbeatRunStatus } from "../services/heartbeat.ts";
import { createHeartbeatQueuedStaleRecovery } from "../services/heartbeat-queued-stale-recovery.ts";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";
import { approvalWaitFixtures } from "./helpers/approval-wait-fixtures.js";

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

const staleQueuedAt = () => new Date(Date.now() - 60_000);

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
    await db.delete(instanceSettings);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(issueApprovals); await db.delete(operatorDecisions); await db.delete(approvals);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missionSessions);
    await db.delete(missions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunFinalizationSteps);
    await db.delete(heartbeatRunFinalizations);
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
    queuedAt?: Date;
    agentStatus?: string;
    maxConcurrentRuns?: number;
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
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: input?.adapterConfig ?? {},
      runtimeConfig: input?.maxConcurrentRuns === undefined ? {} : { heartbeat: { maxConcurrentRuns: input.maxConcurrentRuns } },
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
      status: input?.runStatus === "queued" ? "pending" : "claimed",
      runId,
      claimedAt: now,
      createdAt: input?.queuedAt ?? now,
      updatedAt: input?.queuedAt ?? now,
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
      startedAt: input?.runStatus === "queued" ? null : now,
      createdAt: input?.queuedAt ?? now,
      updatedAt: input?.updatedAt ?? input?.queuedAt ?? new Date("2026-03-19T00:00:00.000Z"),
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

  async function seedRunnableAgent(input?: { adapterConfig?: Record<string, unknown>; maxConcurrentRuns?: number }) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue recovery", issuePrefix: `Q${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Queue runner", role: "engineer", status: "active", adapterType: "process",
      adapterConfig: input?.adapterConfig ?? {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: input?.maxConcurrentRuns ?? 1 } }, permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertOrphanWake(companyId: string, agentId: string, options?: { id?: string; issueId?: string | null; missionId?: string | null; reason?: string }) {
    const wakeupRequestId = options?.id ?? randomUUID();
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system", reason: options?.reason ?? "manual",
      payload: {}, issueId: options?.issueId ?? null, missionId: options?.missionId ?? null,
      status: "queued", runId: null, createdAt: staleAt, updatedAt: staleAt,
    });
    return wakeupRequestId;
  }

  async function insertRunningRun(companyId: string, agentId: string, wakeupRequestId = randomUUID()) {
    const id = randomUUID(), now = new Date();
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system", reason: "manual", payload: {}, status: "claimed", runId: id });
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "running", wakeupRequestId, contextSnapshot: {}, startedAt: now, updatedAt: now });
    return { id, wakeupRequestId };
  }

  function createCountingCommand() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-queue-count-"));
    tempDirs.add(dir);
    const command = path.join(dir, "count.cjs"), countPath = path.join(dir, "count.txt");
    fs.writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('node:fs');let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(countPath)},'utf8'))}catch{};fs.writeFileSync(${JSON.stringify(countPath)},String(n+1));\n`, "utf8");
    fs.chmodSync(command, 0o755);
    return { command, countPath };
  }

  function makeQueuedRecovery(beforeLock?: (agentId: string) => Promise<void>, setRunStatus = setHeartbeatRunStatus) {
    const effects = { runEvents: 0, queueEvents: 0, releases: 0, settlements: 0, finalizations: 0, liveStatusEvents: 0 };
    const recovery = createHeartbeatQueuedStaleRecovery({
      db, activeExecutionTimeoutMs: 0,
      withAgentStartLock: async (agentId, fn) => { await beforeLock?.(agentId); return fn(); },
      startNextQueuedRunForAgent: async () => [],
      countActiveRunsForAgent: async agentId => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length,
      maxConcurrentRuns: agent => {
        const config = agent.runtimeConfig as Record<string, unknown>;
        return Number((config.heartbeat as Record<string, unknown> | undefined)?.maxConcurrentRuns ?? 1);
      },
      hasActiveExecution: () => false,
      hasLiveTrackedChild: runId => {
        const child = runningProcesses.get(runId)?.child;
        return Boolean(child && child.exitCode === null && child.signalCode === null && isPidAlive(child.pid));
      },
      resolveActiveExecutionTimeoutMs: async () => 0,
      setRunStatus, publishRunStatus: () => { effects.liveStatusEvents++; }, nextRunEventSeq: async () => 1,
      appendRunEvent: async () => { effects.runEvents++; }, releaseIssueExecutionAndPromote: async () => { effects.releases++; },
      getRun: runId => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0] ?? null),
      settleHeartbeatAfterExecution: async () => { effects.settlements++; }, finalizeAgentStatus: async () => { effects.finalizations++; },
      recordQueueTransitionEvent: async () => { effects.queueEvents++; },
    });
    return { recover: recovery, effects };
  }

  async function setFinalizationV1(enabled: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: enabled },
    });
  }

  it.each([{ terminal: false }, { terminal: true }])("preserves the original queue behind a live blocker (terminal-unsettled v1=$terminal)", async ({ terminal }) => {
    await setFinalizationV1(terminal);
    const command = createCountingCommand();
    const queued = await seedRunFixture({ adapterType: "process", adapterConfig: { command: command.command }, runStatus: "queued", agentStatus: "active", maxConcurrentRuns: 1, queuedAt: staleQueuedAt() });
    const blocker = await insertRunningRun(queued.companyId, queued.agentId), child = spawnAliveProcess();
    childProcesses.add(child); runningProcesses.set(blocker.id, { child, graceSec: 1 });
    await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    if (terminal) await db.update(heartbeatRuns).set({
      status: "succeeded", finishedAt: new Date(), finalizationVersion: 1, settledAt: null,
    }).where(eq(heartbeatRuns.id, blocker.id));
    const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
    const [beforeWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    expect((await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(0);
    const [waitingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
    const [waitingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    expect(waitingRun).toMatchObject({ id: beforeRun.id, status: "queued", wakeupRequestId: beforeRun.wakeupRequestId, issueId: beforeRun.issueId, createdAt: beforeRun.createdAt, updatedAt: beforeRun.updatedAt });
    expect(waitingWake).toMatchObject({ id: beforeWake.id, status: "pending", runId: queued.runId, updatedAt: beforeWake.updatedAt });
    const [waitingBlocker] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, blocker.id));
    expect(waitingBlocker).toMatchObject(terminal
      ? { status: "succeeded", finalizationVersion: 1, settledAt: null }
      : { status: "running" });
    expect(fs.existsSync(command.countPath)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, queued.issueId));
    expect(issue).toMatchObject({ checkoutRunId: queued.runId, executionRunId: queued.runId });
    child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0); runningProcesses.delete(blocker.id);
    await db.update(heartbeatRuns).set(terminal
      ? { settledAt: new Date(), updatedAt: new Date() }
      : { status: "succeeded", finishedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await heartbeatService(db).resumeQueuedRuns(queued.agentId);
    expect(await waitForRunStatus(db, queued.runId, "succeeded")).toMatchObject({ id: queued.runId, wakeupRequestId: queued.wakeupRequestId });
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it.each(["bare-pid", "tracked-exited-child", "other-agent", "other-company"] as const)("does not treat %s as live capacity for another queue", async kind => {
    let companyId: string, agentId: string;
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", maxConcurrentRuns: 1, queuedAt: staleQueuedAt() });
    companyId = target.companyId; agentId = target.agentId;
    if (kind === "other-agent") {
      agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Other agent", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    } else if (kind === "other-company") ({ companyId, agentId } = await seedRunnableAgent());
    const blocker = await insertRunningRun(companyId, agentId);
    let child: ChildProcess | null = null;
    if (kind === "tracked-exited-child") {
      child = spawnAliveProcess(); childProcesses.add(child); child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0);
      runningProcesses.set(blocker.id, { child, graceSec: 1 });
    } else if (kind === "other-agent" || kind === "other-company") {
      child = spawnAliveProcess(); childProcesses.add(child); runningProcesses.set(blocker.id, { child, graceSec: 1 });
    }
    await db.update(heartbeatRuns).set({ processPid: kind === "bare-pid" ? process.pid : child?.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    await makeQueuedRecovery().recover(1_000);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]).toMatchObject({ status: "failed", errorCode: "stale_queued" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, blocker.id)))[0]).toMatchObject({ status: "running" });
  });

  it("fails only the stale queued sibling and preserves the fresh sibling fields", async () => {
    const stale = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", queuedAt: staleQueuedAt() });
    const siblingId = randomUUID(), wakeId = randomUUID(), freshAt = new Date();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: stale.companyId, agentId: stale.agentId, source: "automation", triggerDetail: "system", reason: "fresh sibling", payload: {}, status: "pending", runId: siblingId, createdAt: freshAt, updatedAt: freshAt });
    await db.insert(heartbeatRuns).values({ id: siblingId, companyId: stale.companyId, agentId: stale.agentId, invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: wakeId, contextSnapshot: {}, startedAt: null, createdAt: freshAt, updatedAt: freshAt });
    expect((await makeQueuedRecovery().recover(1_000)).reapedRunIds).toEqual([stale.runId]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stale.runId)))[0]).toMatchObject({ status: "failed", errorCode: "stale_queued", finishedAt: expect.any(Date) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, siblingId)))[0]).toMatchObject({ status: "queued", error: null, errorCode: null, finishedAt: null, createdAt: freshAt, updatedAt: freshAt });
  });

  it("expires an invalid stale orphan without making a heartbeat or starting an adapter", async () => {
    const command = createCountingCommand(), agent = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const issueId = randomUUID(), wakeId = await insertOrphanWake(agent.companyId, agent.agentId, { issueId });
    await db.update(agentWakeupRequests).set({ payload: { issueId } }).where(eq(agentWakeupRequests.id, wakeId));
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake).toMatchObject({ status: "failed", runId: null, finishedAt: expect.any(Date) });
    expect(wake.error).toMatch(/issue not found/i);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeId))).toHaveLength(0);
    expect(fs.existsSync(command.countPath)).toBe(false);
  });

  it.each(["decision", "approval"] as const)("skips an approval-waiting wake and promotes the next valid wake (%s)", async kind => {
    const command = createCountingCommand(), fixtures = approvalWaitFixtures(db), base = await fixtures.seedBase();
    await db.update(agents).set({ status: "active", adapterType: "process", adapterConfig: { command: command.command }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, base.agentId));
    await db.update(issues).set({ assigneeAgentId: base.agentId }).where(eq(issues.id, base.issueId));
    if (kind === "decision") await fixtures.seedPendingDecision(base.companyId, base.issueId);
    else await fixtures.seedPendingApproval(base.companyId, base.issueId);
    const waiting = await fixtures.seedRun({ ...base, status: "queued", withRunRow: false });
    const validId = await insertOrphanWake(base.companyId, base.agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, base.agentId))).toHaveLength(0);
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const [waitingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.wakeupId));
    const [validWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, validId));
    expect(waitingWake).toMatchObject({ status: "queued", runId: null });
    expect(validWake?.runId).toBeTypeOf("string");
    expect(await waitForRunStatus(db, validWake!.runId!, "succeeded")).toMatchObject({ wakeupRequestId: validId });
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

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

  it("terminalizes an active linked run as cancelled (control-plane cut) when an issue is marked blocked", async () => {
    const { companyId, runId, wakeupRequestId, issueId, agentId } = await seedRunFixture();
    // finalizeAgentStatus 는 paused 에서 조기 반환하므로 에이전트 관찰 가능 상태로 만든다.
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, agentId));

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
      // [run honesty] 통제판 절단은 실패가 아니다 — 사유는 errorCode 로 구분한다.
      status: "cancelled",
      errorCode: "issue_status_blocked",
      finishedAt: expect.any(Date),
    }));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: expect.any(Date),
    }));

    // 2차 오염 방지: 통제판 절단으로 에이전트가 error 로 마킹되지 않아야 한다
    //   (2026-08-19 GAZ: error 마킹이 오너의 재할당 판단을 흔들었다).
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("idle");
  });

  // [stale-run auto-block guard, 2026-10-07 CMP-328] 이전 run 이 늦게 끝나도 지금 다른 run 이
  //   소유한 이슈를 blocked 로 만들거나 소유 칸을 지우면 안 된다(소유 run 만 자동 차단).
  async function seedStaleRunWithNewOwner() {
    const fixture = await seedRunFixture();
    const newRunId = randomUUID();
    await db.update(heartbeatRuns).set({ issueId: fixture.issueId }).where(eq(heartbeatRuns.id, fixture.runId));
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      issueId: fixture.issueId,
      contextSnapshot: { issueId: fixture.issueId },
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    await db.update(issues)
      .set({ checkoutRunId: newRunId, executionRunId: newRunId })
      .where(eq(issues.id, fixture.issueId));
    return { ...fixture, newRunId };
  }

  it("does not auto-block or clear the lock when a stale non-owner run of the same issue ends", async () => {
    const { runId, newRunId, issueId } = await seedStaleRunWithNewOwner();

    await heartbeatService(db).cancelRun(runId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBe(newRunId);
    expect(issue?.executionRunId).toBe(newRunId);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities.some((row) => row.action === "issue.run_failure_auto_blocked")).toBe(false);
  });

  it("still auto-blocks the issue when the cancelled run is the current owner", async () => {
    const { runId, issueId } = await seedRunFixture();

    await heartbeatService(db).cancelRun(runId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.checkoutRunId).toBeNull();
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities.some((row) => row.action === "issue.run_failure_auto_blocked")).toBe(true);
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

  it("fails a free stale queue once and releases its issue", async () => {
    const command = createCountingCommand();
    const { runId, issueId, wakeupRequestId } = await seedRunFixture({ runStatus: "queued", queuedAt: staleQueuedAt(), agentStatus: "active", adapterType: "process", adapterConfig: { command: command.command } });
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(1);
    expect((await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(0);
    expect((await heartbeat.getRun(runId))?.errorCode).toBe("stale_queued");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]?.status).toBe("failed");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.executionRunId).toBeNull();
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.filter(event => event.eventType === "lifecycle" && event.message?.startsWith("Queued heartbeat run exceeded"))).toHaveLength(1);
    await heartbeat.resumeQueuedRuns();
    expect(fs.existsSync(command.countPath)).toBe(false);
  });

  it("publishes a stale status only after commit and never after rollback", async () => {
    const committed = await seedRunFixture({ runStatus: "queued", includeIssue: false, queuedAt: staleQueuedAt() });
    const winner = makeQueuedRecovery();
    await winner.recover(1_000);
    expect(winner.effects.liveStatusEvents).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, committed.runId)))[0]?.status).toBe("failed");

    const rolledBack = await seedRunFixture({ runStatus: "queued", includeIssue: false, queuedAt: staleQueuedAt() });
    const rollback = makeQueuedRecovery(undefined, async (tx, runId, status, patch, options) => {
      await setHeartbeatRunStatus(tx, runId, status, patch, options);
      throw new Error("force stale transition rollback");
    });
    await rollback.recover(1_000);
    expect(rollback.effects.liveStatusEvents).toBe(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, rolledBack.runId)))[0]?.status).toBe("queued");
  });

  it.each([
    { capacity: 2, live: 1, statusOnly: false, expected: "failed" },
    { capacity: 2, live: 2, statusOnly: false, expected: "queued" },
    { capacity: 2, live: 0, statusOnly: true, expected: "failed" },
    { capacity: 1, live: 1, resizeTo: 2, expected: "failed" },
    { capacity: 1, live: 0, statusOnly: false, terminal: true, finalization: true, expected: "failed" },
    { capacity: 1, live: 1, statusOnly: false, terminal: true, finalization: false, expected: "failed" },
  ])("protects only a positively full current capacity ($capacity/$live)", async ({ capacity, live, statusOnly, resizeTo, terminal, finalization, expected }) => {
    if (finalization !== undefined) await setFinalizationV1(finalization);
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", maxConcurrentRuns: capacity, queuedAt: staleQueuedAt() });
    const children: ChildProcess[] = [];
    for (let i = 0; i < Math.max(live, Number(Boolean(statusOnly)), Number(Boolean(terminal))); i++) {
      const blocker = await insertRunningRun(target.companyId, target.agentId);
      if (i < live) {
        const child = spawnAliveProcess(); childProcesses.add(child); children.push(child);
        await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
        runningProcesses.set(blocker.id, { child, graceSec: 1 });
      }
      if (terminal) await db.update(heartbeatRuns).set({ status: "succeeded", finalizationVersion: 1, settledAt: null }).where(eq(heartbeatRuns.id, blocker.id));
    }
    const recovery = makeQueuedRecovery(resizeTo ? async () => {
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: resizeTo } } }).where(eq(agents.id, target.agentId));
    } : undefined);
    await recovery.recover(1_000);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]?.status).toBe(expected);
    if (statusOnly) expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, target.agentId))).filter(run => run.status === "running")).toHaveLength(1);
  });

  it("keeps an unlinked stale wake while full, then starts that same request once", async () => {
    const command = createCountingCommand();
    const { companyId, agentId } = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const blocker = await insertRunningRun(companyId, agentId), child = spawnAliveProcess(); childProcesses.add(child);
    await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    runningProcesses.set(blocker.id, { child, graceSec: 1 });
    const wakeupRequestId = await insertOrphanWake(companyId, agentId);
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const preserved = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(first.reaped).toBe(0);
    expect(preserved.status).toBe("queued");
    expect(preserved.runId).toBeNull();
    expect(fs.existsSync(command.countPath)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeupRequestId))).length).toBe(0);
    child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0); runningProcesses.delete(blocker.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await heartbeat.resumeQueuedRuns(agentId);
    const promoted = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(promoted.runId).toBeTypeOf("string");
    expect((await waitForRunStatus(db, promoted.runId!, "succeeded"))?.wakeupRequestId).toBe(wakeupRequestId);
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it("promotes a valid wake with no heartbeat rows through the ordinary queue", async () => {
    const command = createCountingCommand(), { companyId, agentId } = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const wakeupRequestId = await insertOrphanWake(companyId, agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const wakeup = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(wakeup.runId).toBeTypeOf("string");
    expect((await waitForRunStatus(db, wakeup.runId!, "succeeded"))?.wakeupRequestId).toBe(wakeupRequestId);
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it("discards stale decisions when a run claim or wake attachment wins", async () => {
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", queuedAt: staleQueuedAt() });
    let reachedBeforeLock = false;
    const claim = makeQueuedRecovery(async () => {
      reachedBeforeLock = true;
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, target.runId));
    });
    expect((await claim.recover(1_000)).reapedRunIds).toEqual([]);
    expect(reachedBeforeLock).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]).toMatchObject({ status: "running", startedAt: expect.any(Date) });
    expect(claim.effects).toMatchObject({ runEvents: 0, liveStatusEvents: 0, releases: 0, settlements: 0, finalizations: 0 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, target.wakeupRequestId)))[0]?.status).toBe("pending");

    const agent = await seedRunnableAgent(), attachedId = await insertOrphanWake(agent.companyId, agent.agentId);
    const winner = await insertRunningRun(agent.companyId, agent.agentId);
    const attached = makeQueuedRecovery(async () => { await db.update(agentWakeupRequests).set({ runId: winner.id, updatedAt: new Date() }).where(eq(agentWakeupRequests.id, attachedId)); });
    await attached.recover(1_000);
    const [attachedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, attachedId));
    expect(attachedWake).toMatchObject({ status: "queued", runId: winner.id });
    expect(attached.effects.queueEvents).toBe(0);
  });

  it("preserves a fresh reverse-linked heartbeat while refusing to orphan its stale wake", async () => {
    const agent = await seedRunnableAgent(), reverseId = await insertOrphanWake(agent.companyId, agent.agentId);
    const reverseRunId = randomUUID(), freshAt = new Date();
    await db.insert(heartbeatRuns).values({ id: reverseRunId, companyId: agent.companyId, agentId: agent.agentId, invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: reverseId, contextSnapshot: {}, startedAt: null, createdAt: freshAt, updatedAt: freshAt });
    const recovery = makeQueuedRecovery();
    await recovery.recover(1_000);
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, reverseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, reverseRunId));
    expect(wakeup).toMatchObject({ status: "queued", runId: null });
    expect(run).toMatchObject({ status: "queued", errorCode: null, finishedAt: null, wakeupRequestId: reverseId });
    expect(recovery.effects.queueEvents).toBe(0);
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

  it("skips release+promote when the bound issue is locked by another transaction (SKIP LOCKED)", async () => {
    // Regression: releaseIssueExecutionAndPromote locks the issue with FOR UPDATE
    // SKIP LOCKED. If another transaction holds the row lock, the lock select returns
    // no rows and the whole transaction must bail early (return null) instead of
    // waiting — otherwise the recovery lane hangs on the lock wait.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "SkipLocked Co",
      issuePrefix: `SL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SkipLocked Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "in_progress",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "claimed",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      issueId,
      wakeupRequestId,
      contextSnapshot: {},
    });
    // Link execution_run_id AFTER the run exists (FK: issues.execution_run_id -> heartbeat_runs.id).
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);

    // Hold the issue row lock in a separate transaction.
    const heldLock = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      // While the lock is held, reapOrphanedRuns must NOT hang; the run is
      // terminal and would otherwise go through release+promote.
      const result = await heartbeat.reapOrphanedRuns();
      return result;
    });

    expect(heldLock.reaped).toBe(1); // run itself is reaped (terminalized)…
    // …but the release+promote step bailed early (return null) — the issue lock
    // was not acquired, so execution_run_id is still set (no early cleanup).
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).toBe(runId);
  });
});
