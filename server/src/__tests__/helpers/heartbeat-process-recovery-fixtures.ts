// Pid/process and seed/recovery helpers moved out of heartbeat-process-recovery.test.ts
// (T16d, file <=1000 lines). Bodies are verbatim; the describe-scoped db handle is bound
// by bindHeartbeatProcessRecoveryDb from the caller's own describe, after its beforeAll.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { createDb, agents, agentWakeupRequests, companies, heartbeatRuns, instanceSettings, issues } from "@paperclipai/db";
import { runningProcesses } from "../../adapters/index.ts";
import { setHeartbeatRunStatus } from "../../services/heartbeat.ts";
import { createHeartbeatQueuedStaleRecovery } from "../../services/heartbeat-queued-stale-recovery.ts";
import { beforeAll } from "vitest";

let db!: ReturnType<typeof createDb>;
let tempDirs!: Set<string>;
export function bindHeartbeatProcessRecoveryDb(dbGet: () => ReturnType<typeof createDb>, tempDirsArg: Set<string>) {
  tempDirs = tempDirsArg;
  beforeAll(() => {
    db = dbGet();
  });
}

export function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

export const staleQueuedAt = () => new Date(Date.now() - 60_000);

export function isPidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

export async function waitForPidExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

export async function waitForRunStatus(
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

  export async function seedRunFixture(input?: {
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

  export async function seedRunnableAgent(input?: { adapterConfig?: Record<string, unknown>; maxConcurrentRuns?: number }) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue recovery", issuePrefix: `Q${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Queue runner", role: "engineer", status: "active", adapterType: "process",
      adapterConfig: input?.adapterConfig ?? {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: input?.maxConcurrentRuns ?? 1 } }, permissions: {},
    });
    return { companyId, agentId };
  }

  export async function insertOrphanWake(companyId: string, agentId: string, options?: { id?: string; issueId?: string | null; missionId?: string | null; reason?: string }) {
    const wakeupRequestId = options?.id ?? randomUUID();
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system", reason: options?.reason ?? "manual",
      payload: {}, issueId: options?.issueId ?? null, missionId: options?.missionId ?? null,
      status: "queued", runId: null, createdAt: staleAt, updatedAt: staleAt,
    });
    return wakeupRequestId;
  }

  export async function insertRunningRun(companyId: string, agentId: string, wakeupRequestId = randomUUID()) {
    const id = randomUUID(), now = new Date();
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system", reason: "manual", payload: {}, status: "claimed", runId: id });
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "running", wakeupRequestId, contextSnapshot: {}, startedAt: now, updatedAt: now });
    return { id, wakeupRequestId };
  }

  export function createCountingCommand() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-queue-count-"));
    tempDirs.add(dir);
    const command = path.join(dir, "count.cjs"), countPath = path.join(dir, "count.txt");
    fs.writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('node:fs');let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(countPath)},'utf8'))}catch{};fs.writeFileSync(${JSON.stringify(countPath)},String(n+1));\n`, "utf8");
    fs.chmodSync(command, 0o755);
    return { command, countPath };
  }

  export function makeQueuedRecovery(beforeLock?: (agentId: string) => Promise<void>, setRunStatus = setHeartbeatRunStatus) {
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

  export async function setFinalizationV1(enabled: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: enabled },
    });
  }
