import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe } from "vitest";
import { applyPendingMigrations, createDb, ensurePostgresDatabase, approvals, agents, agentRuntimeState, agentWikiEntries, companySkills, companySecrets, activityLog, agentWakeupRequests, companies, heartbeatRunEvents, heartbeatRunFinalizationSteps, heartbeatRunFinalizations, heartbeatRuns, instanceSettings, issueApprovals, issues, issueComments, missionSessions, missions, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { registerHeartbeatProcessRecoveryCasesA } from "./helpers/heartbeat-process-recovery-cases-a.js";
import { registerHeartbeatProcessRecoveryCasesB } from "./helpers/heartbeat-process-recovery-cases-b.js";
import { bindHeartbeatProcessRecoveryDb } from "./helpers/heartbeat-process-recovery-fixtures.js";

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
    await waitForHeartbeatExecutionsToDrain(db, 5_000);
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
    if (db) await waitForHeartbeatExecutionsToDrain(db, 5_000);
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


  bindHeartbeatProcessRecoveryDb(() => db, tempDirs);

  registerHeartbeatProcessRecoveryCasesA({
    getDb: () => db,
    tempDirs,
    childProcesses,
  });

  registerHeartbeatProcessRecoveryCasesB({
    getDb: () => db,
    childProcesses,
  });
});
