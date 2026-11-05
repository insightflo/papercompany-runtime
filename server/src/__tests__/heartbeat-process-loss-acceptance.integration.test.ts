import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, heartbeatRuns } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { isProcessAlive } from "../services/heartbeat-process-liveness.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
const ownedPids = new Set<number>();
const ownedServers: Array<Awaited<ReturnType<typeof f.startServer>>> = [];
beforeAll(async () => { f = await startRuntimeShutdownProcessFixture(); }, 120_000);
afterEach(async () => {
  for (const server of ownedServers.splice(0)) { server.signal("SIGKILL"); await server.waitExit(); }
  for (const pid of ownedPids) if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  ownedPids.clear();
}, 120_000);
afterAll(async () => {
  await f?.cleanup();
}, 120_000);

async function startServer() {
  const server = await f.startServer(undefined, { HEARTBEAT_SCHEDULER_ENABLED: "true" });
  ownedServers.push(server);
  return server;
}

async function createRunningFixture(retryCount: number, keepRetryAlive = false) {
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
  const marker = path.join(f.root, `m02-${runId}.jsonl`), script = path.join(f.root, `m02-${runId}.mjs`);
  await writeFile(script, `#!/usr/bin/env node
import fs from 'node:fs';
const file=${JSON.stringify(marker)};
const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).length:0;
fs.appendFileSync(file,JSON.stringify({pid:process.pid,attempt:previous+1})+'\\n');
if(previous===0 || ${keepRetryAlive}) setInterval(()=>{},1000);
else { console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'local recovery complete'}})); process.exit(0); }
`);
  await chmod(script, 0o755);
  await f.db.insert(companies).values({ id: companyId, name: "Recovery acceptance", issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 7)}` });
  await f.db.insert(agents).values({ id: agentId, companyId, name: "Recovery worker", status: "idle", adapterType: "codex_local",
    adapterConfig: { command: script, cwd: f.root, promptTemplate: "Run the local recovery fixture." }, runtimeConfig: {} });
  await f.db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", status: "queued", runId });
  await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", invocationSource: "on_demand",
    wakeupRequestId: wakeId, processLossRetryCount: retryCount, contextSnapshot: { taskKey: `m02-${runId}` } });
  const starts = async () => {
    try { return (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; attempt: number }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { companyId, agentId, runId, wakeId, starts };
}

async function loseServerAndChild(input: Awaited<ReturnType<typeof createRunningFixture>>) {
  const server = await startServer();
  const first = await f.waitFor(async () => {
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const starts = await input.starts();
    if (starts[0]?.pid) ownedPids.add(starts[0].pid);
    return run?.status === "running" && run.processPid && starts[0]?.pid === run.processPid ? starts[0] : null;
  }, "local recovery child started", 60_000);
  server.signal("SIGKILL");
  expect((await server.waitExit()).signal).toBe("SIGKILL");
  process.kill(first.pid, "SIGKILL");
  await f.waitFor(async () => !isProcessAlive(first.pid) ? true : null, "lost child exited", 15_000);
  ownedPids.delete(first.pid);
  return first;
}

it("restarts a real lost local child once and preserves the completed retry across another server restart", async () => {
  const input = await createRunningFixture(0), first = await loseServerAndChild(input);
  const restarted = await startServer();
  const retry = await f.waitFor(async () => {
    const rows = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
    const child = rows.find(row => row.retryOfRunId === input.runId);
    return child?.status === "succeeded" ? child : null;
  }, "process loss retry completed", 90_000);
  const rows = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === input.runId)).toMatchObject({ status: "failed", errorCode: "process_lost" });
  expect(retry).toMatchObject({ retryOfRunId: input.runId, processLossRetryCount: 1, status: "succeeded" });
  expect((await input.starts()).map(row => row.attempt)).toEqual([1, 2]);
  restarted.signal("SIGTERM"); expect((await restarted.waitExit()).code).toBe(0);
  const again = await startServer();
  again.signal("SIGTERM"); expect((await again.waitExit()).code).toBe(0);
  const finalRows = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
  expect(finalRows).toHaveLength(2); expect((await input.starts()).map(row => row.attempt)).toEqual([1, 2]);
  f.recordEvidence("t16a-process-loss-retry", again, { companyId: input.companyId, firstRunId: input.runId,
    firstPid: first.pid, retryRunId: retry.id, retryCount: retry.processLossRetryCount, starts: await input.starts() });
}, 240_000);

it("exhausts the retry budget after two actual process losses without starting a third child", async () => {
  const input = await createRunningFixture(0, true), first = await loseServerAndChild(input);
  const retryServer = await startServer();
  const retry = await f.waitFor(async () => {
    const rows = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
    const child = rows.find(row => row.retryOfRunId === input.runId);
    const starts = await input.starts();
    if (starts[1]?.pid) ownedPids.add(starts[1].pid);
    return child?.status === "running" && starts[1]?.pid && child.processPid === starts[1].pid
      ? { run: child, pid: starts[1].pid } : null;
  }, "retry child started", 90_000);
  expect(retry.run.processLossRetryCount).toBe(1);
  retryServer.signal("SIGKILL");
  expect((await retryServer.waitExit()).signal).toBe("SIGKILL");
  process.kill(retry.pid, "SIGKILL");
  await f.waitFor(async () => !isProcessAlive(retry.pid) ? true : null, "lost retry child exited", 15_000);
  ownedPids.delete(retry.pid);
  const restarted = await startServer();
  await f.waitFor(async () => {
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.run.id));
    return run?.status === "failed" && run.errorCode === "process_lost" ? true : null;
  }, "exhausted process loss recorded", 90_000);
  const rows = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === input.runId)).toMatchObject({ status: "failed", errorCode: "process_lost" });
  expect(rows.find(row => row.id === retry.run.id)).toMatchObject({ status: "failed", errorCode: "process_lost", processLossRetryCount: 1 });
  expect((await input.starts()).map(row => row.attempt)).toEqual([1, 2]);
  restarted.signal("SIGTERM"); expect((await restarted.waitExit()).code).toBe(0);
  const again = await startServer();
  again.signal("SIGTERM"); expect((await again.waitExit()).code).toBe(0);
  expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId))).toHaveLength(2);
  expect((await input.starts()).map(row => row.attempt)).toEqual([1, 2]);
  f.recordEvidence("t16a-process-loss-exhausted", again, { companyId: input.companyId, runId: input.runId,
    firstPid: first.pid, retryRunId: retry.run.id, retryPid: retry.pid, retryCount: 1, starts: await input.starts() });
}, 240_000);
