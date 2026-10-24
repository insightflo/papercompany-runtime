import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings,
  missionAgentRuntimes, missions, workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logger } from "../middleware/logger.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import { createPauseExecutionObservation, recordPauseQuiescence } from "../services/heartbeat-pause-quiescence.js";
import { settleHeartbeatAfterExecution } from "../services/heartbeat-finalization/post-execution.js";
import * as intents from "../services/heartbeat-pause-intents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const completed = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let db: Db, peer: Db, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, root: string;
const children = new Set<ChildProcess>(), agentIds = new Set<string>(), runIds = new Set<string>();
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-stop-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-c05-stop-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({ singletonKey: "default" });
}, 60_000);
afterEach(async () => {
  if (agentIds.size) await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitForHeartbeatExecutionsToDrain(db);
  for (const child of children) await vi.waitFor(() =>
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 3000 });
  for (const id of runIds) runningProcesses.delete(id);
  children.clear(); agentIds.clear(); runIds.clear(); adapter.mockReset();
}, 60_000);
afterAll(async () => {
  await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 60_000);
const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
async function receipts(agentId: string) {
  return (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
    .filter(r => r.source === "internal_agent_pause_v1").map(readPauseControl)
    .filter((p): p is PauseReceipt => p.kind === "receipt").sort((a, b) => a.id.localeCompare(b.id));
}
async function world(enabled: boolean) {
  await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: enabled } });
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05 stop", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Isolated stop test" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
  agentIds.add(agentId);
  return { companyId, agentId, service: heartbeatService(db) };
}
async function childProcess() {
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{});process.stdin.on('data',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)"],
  { stdio: ["pipe", "pipe", "ignore"] });
  children.add(child); await once(child.stdout!, "data"); return child;
}
async function exit(child: ChildProcess) {
  const ended = once(child, "close"); child.stdin!.end("exit"); await ended;
  expect(child.exitCode).toBe(0);
}
async function paused(w: Awaited<ReturnType<typeof world>>) {
  await w.service.pauseAgent(w.agentId); await w.service.resumeAgent(w.agentId);
  expect((await receipts(w.agentId)).every(p => p.resumeScopeId === p.ownerScopeId && !p.stopped && !p.delivery)).toBe(true);
}
async function manual(enabled: boolean, extra = false) {
  const w = await world(enabled), child = await childProcess(), id = randomUUID(), wakeId = randomUUID(), missionId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId: w.companyId, ownerAgentId: w.agentId, title: "stop resource" });
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: w.companyId, agentId: w.agentId,
    missionId, source: "assignment", status: "claimed", runId: id });
  await db.insert(heartbeatRuns).values({ id, companyId: w.companyId, agentId: w.agentId, wakeupRequestId: wakeId,
    status: "running", startedAt: new Date(), processPid: child.pid!, processStartedAt: new Date(),
    finalizationVersion: enabled ? 1 : 0, executionScopeKind: "mission_nonworkflow", executionEpoch: 2,
    executionToken: randomUUID(), executorOwnerId: "test", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID() });
  runIds.add(id); runningProcesses.set(id, { child, graceSec: 1 });
  if (extra) {
    const otherId = randomUUID(), otherWake = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: otherWake, companyId: w.companyId, agentId: w.agentId,
      missionId, source: "assignment", status: "claimed", runId: otherId });
    await db.insert(heartbeatRuns).values({ id: otherId, companyId: w.companyId, agentId: w.agentId,
      wakeupRequestId: otherWake, status: "running", startedAt: new Date() });
    runIds.add(otherId);
  }
  const original = await readRun(id); await paused(w);
  return { ...w, child, id, missionId, original };
}
async function settle(w: Awaited<ReturnType<typeof manual>>, enabled: boolean) {
  if (enabled) await settleHeartbeatAfterExecution(db, await readRun(w.id), new Date());
}

// Independent C05 oracle: adopted plan:46-52,112-117,143.
// Same pause -> resume ONCE input: while alive/no cleanup => stopped=null and zero successors;
// actual exit + all original resources stopped => exact proof and one completed successor.
// The final contract replaces the earlier stage's delivery=null / one total execution expectation.
it.each([false, true].flatMap(enabled => [false, true].map(storageFailure => ({ enabled, storageFailure }))))(
  "real executeRun cleanup and requery resume once, finalization=$enabled, storageFailure=$storageFailure", async ({ enabled, storageFailure }) => {
  const w = await world(enabled), warn = vi.spyOn(logger, "warn");
  onTestFinished(() => { warn.mockRestore(); });
  let child: ChildProcess | undefined;
  adapter.mockResolvedValue(completed).mockImplementationOnce(async (ctx: AdapterExecutionContext) => {
    child = await childProcess(); runningProcesses.set(ctx.runId, { child, graceSec: 1 }); runIds.add(ctx.runId);
    await ctx.onSpawn?.({ pid: child.pid!, startedAt: new Date().toISOString() });
    await once(child, "close"); runningProcesses.delete(ctx.runId); return completed;
  });
  await w.service.wakeup(w.agentId, { source: "on_demand", triggerDetail: "manual", reason: "c05_stop" });
  await vi.waitFor(async () => {
    expect(child?.pid).toBeTypeOf("number");
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId));
    expect(rows).toHaveLength(1); expect(rows[0].processPid).toBe(child!.pid);
  }, { timeout: 10_000 });
  const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId));
  await paused(w);
  expect(child!.exitCode).toBeNull(); expect(child!.signalCode).toBeNull();
  expect(runningProcesses.has(original.id)).toBe(false); // Pause deletes the handle before exit.
  if (!storageFailure) expect(await recordPauseQuiescence(peer, original)).toBe(0);
  await heartbeatService(peer).resumeQueuedRuns(w.agentId);
  expect(child!.exitCode).toBeNull(); expect(child!.signalCode).toBeNull();
  expect((await receipts(w.agentId))[0]).toMatchObject({ stopped: null, delivery: null });
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId))).toHaveLength(1);
  expect(adapter).toHaveBeenCalledTimes(1);
  expect((await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, w.agentId)))
    .filter(r => r.requestKind === "agent_pause_resume")).toHaveLength(0);
  const before = await receipts(w.agentId), controlId = before[0].id;
  if (storageFailure) {
    onTestFinished(async () => {
      await db.$client.unsafe("DROP TRIGGER IF EXISTS c05_stop_failure ON agent_wakeup_requests; DROP FUNCTION IF EXISTS c05_stop_failure()");
    });
    await db.$client.unsafe("CREATE FUNCTION c05_stop_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
      + "IF NEW.id='" + controlId + "' THEN RAISE EXCEPTION 'c05 stop middle write'; END IF; RETURN NEW; END $$;"
      + "CREATE TRIGGER c05_stop_failure BEFORE UPDATE ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION c05_stop_failure()");
  }
  await exit(child!); await waitForHeartbeatExecutionsToDrain(db);
  if (storageFailure) {
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ runId: original.id }), "failed to record pause execution quiescence");
    const failures = warn.mock.calls.filter(call => call[1] === "failed to record pause execution quiescence");
    expect(failures).toHaveLength(1);
    let error = (failures[0][0] as { err: unknown }).err;
    const messages: string[] = [];
    while (error instanceof Error) { messages.push(error.message); error = (error as Error & { cause?: unknown }).cause; }
    expect(messages.join("\n")).toContain("c05 stop middle write");
    expect(await receipts(w.agentId)).toEqual(before); expect(adapter).toHaveBeenCalledTimes(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId))).toHaveLength(1);
    await db.$client.unsafe("DROP TRIGGER c05_stop_failure ON agent_wakeup_requests; DROP FUNCTION c05_stop_failure()");
    // C05 adopted:116,143,147: no second resume/direct proof writer; a new service must recover this same intent.
    await heartbeatService(peer).resumeQueuedRuns(); await waitForHeartbeatExecutionsToDrain(peer);
  }
  const saved = await receipts(w.agentId); expect(saved).toHaveLength(1);
  const [receipt] = saved, ended = await readRun(original.id);
  expect(receipt.stopped).toMatchObject({ heartbeatRunId: original.id, executionEpoch: original.executionEpoch,
    executionToken: original.executionToken, method: enabled ? "finalization_quiescence" : "legacy_execution_cleanup" });
  expect(receipt.resumeScopeId).toBe(receipt.ownerScopeId);
  expect(ended.settledAt === null).toBe(!enabled); expect(adapter).toHaveBeenCalledTimes(2);
  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId));
  expect(runs).toHaveLength(2);
  const successors = runs.filter(r => r.retryOfRunId === original.id);
  expect(successors).toHaveLength(1);
  const [successor] = successors;
  expect(successor).toMatchObject({ status: "succeeded", retryOfRunId: original.id });
  expect((adapter.mock.calls[1][0] as AdapterExecutionContext).runId).toBe(successor.id);
  expect(receipt.identity).toMatchObject({ heartbeatRunId: original.id, wakeupRequestId: original.wakeupRequestId });
  expect(receipt.delivery).toEqual({ heartbeatRunId: successor.id, wakeupRequestId: successor.wakeupRequestId });
  const wakes = (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, w.agentId)))
    .filter(r => r.requestKind === "agent_pause_resume");
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ id: successor.wakeupRequestId, runId: successor.id,
    source: "automation", requestKind: "agent_pause_resume", reason: "agent_pause_resume" });
  if (!storageFailure) expect(await recordPauseQuiescence(peer, original)).toBe(0);
  expect(await receipts(w.agentId)).toEqual(saved);
  await w.service.resumeQueuedRuns(w.agentId); await heartbeatService(peer).resumeQueuedRuns();
  await Promise.all([waitForHeartbeatExecutionsToDrain(db), waitForHeartbeatExecutionsToDrain(peer)]);
  expect(adapter).toHaveBeenCalledTimes(2); expect(await receipts(w.agentId)).toEqual(saved);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId))).toHaveLength(2);
  expect((await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, w.agentId)))
    .filter(r => r.requestKind === "agent_pause_resume")).toEqual(wakes);
}, 30_000);

it.each([false, true])("exit without each resource's cleanup never records a stop, finalization=%s", async enabled => {
  const w = await manual(enabled), operationId = randomUUID(), serviceId = randomUUID(), runtimeId = randomUUID();
  await db.insert(workspaceOperations).values({ id: operationId, companyId: w.companyId, heartbeatRunId: w.id, phase: "test" });
  await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId: w.companyId, startedByRunId: w.id,
    scopeType: "run", serviceName: "test", status: "running", lifecycle: "ephemeral", provider: "local" });
  await db.insert(missionAgentRuntimes).values({ id: runtimeId, companyId: w.companyId, agentId: w.agentId,
    missionId: w.missionId, adapterType: "process", runtimeKey: w.id, lastRunId: w.id, status: "busy" });
  expect(await recordPauseQuiescence(db, w.original)).toBe(0); // Real child still ignores SIGTERM.
  await exit(w.child); await settle(w, enabled);
  expect(await recordPauseQuiescence(db, w.original)).toBe(0);
  await db.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date() }).where(eq(workspaceOperations.id, operationId));
  await settle(w, enabled); expect(await recordPauseQuiescence(db, w.original)).toBe(0);
  await db.update(workspaceRuntimeServices).set({ status: "stopped", stoppedAt: new Date() }).where(eq(workspaceRuntimeServices.id, serviceId));
  await settle(w, enabled); expect(await recordPauseQuiescence(db, w.original)).toBe(0);
  expect((await receipts(w.agentId))[0].stopped).toBeNull();
  await db.update(missionAgentRuntimes).set({ status: "stopped", stoppedAt: new Date() }).where(eq(missionAgentRuntimes.id, runtimeId));
  if (enabled) expect(await recordPauseQuiescence(db, w.original)).toBe(0); // Mandatory settlement still missing.
  await settle(w, enabled);
  const counts = await Promise.all([recordPauseQuiescence(db, w.original), recordPauseQuiescence(peer, w.original)]);
  expect(counts.sort()).toEqual([0, 1]); expect((await readRun(w.id)).settledAt === null).toBe(!enabled);
  const [saved] = await receipts(w.agentId);
  expect(saved.stopped).toMatchObject({ heartbeatRunId: w.id, executionEpoch: 2, executionToken: w.original.executionToken });
  expect(saved.delivery).toBeNull(); expect(saved.resumeScopeId).toBe(saved.ownerScopeId);
  expect(await recordPauseQuiescence(db, w.original)).toBe(0); expect(await receipts(w.agentId)).toEqual([saved]);
}, 30_000);

it.each([false, true])("missing PID and OS query errors preserve intent, finalization=%s", async enabled => {
  const w = await manual(enabled); await exit(w.child); await settle(w, enabled);
  const before = await receipts(w.agentId), kill = vi.spyOn(process, "kill"), actualKill = process.kill.bind(process);
  onTestFinished(() => kill.mockRestore());
  kill.mockImplementation((pid, signal) => {
    if (pid === w.child.pid && signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    return actualKill(pid, signal);
  });
  expect(await recordPauseQuiescence(db, w.original)).toBe(0); kill.mockRestore();
  await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, w.id));
  expect(await recordPauseQuiescence(db, w.original)).toBe(0);
  expect(await receipts(w.agentId)).toEqual(before);
}, 30_000);

it("scope replacement and execution epoch/token changes cannot stamp the older observation", async () => {
  const w = await manual(false); await exit(w.child);
  const lock = intents.lockPauseFacts, spy = vi.spyOn(intents, "lockPauseFacts");
  onTestFinished(() => spy.mockRestore());
  spy.mockImplementationOnce(async (tx, input) => {
    await heartbeatService(peer).pauseAgent(w.agentId); return lock(tx, input);
  });
  await expect(recordPauseQuiescence(db, w.original)).rejects.toThrow("heartbeat_pause_scope_unproven_or_changed");
  spy.mockRestore();
  const before = await receipts(w.agentId);
  expect(before[0].ownerScopeId).not.toBe(before[0].resumeScopeId); expect(before[0].stopped).toBeNull();
  await db.update(heartbeatRuns).set({ executionEpoch: 3, executionToken: randomUUID() }).where(eq(heartbeatRuns.id, w.id));
  await expect(recordPauseQuiescence(db, w.original)).rejects.toThrow("heartbeat_pause_scope_unproven_or_changed");
  expect(await receipts(w.agentId)).toEqual(before);
}, 30_000);

it("an unresolved actual adapter promise cannot be replaced by PID absence or handle deletion", async () => {
  const w = await manual(false); await exit(w.child);
  const observation = createPauseExecutionObservation();
  let release!: () => void;
  const execution = observation.execute(w.original, () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await heartbeatService(peer).resumeQueuedRuns(); // Even an absent recorded PID cannot outrun the actual pending adapter.
    expect((await receipts(w.agentId))[0].stopped).toBeNull();
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, w.id));
    expect(await recordPauseQuiescence(db, w.original, observation)).toBe(0);
  }
  finally { release(); await execution; }
  expect((await receipts(w.agentId))[0].stopped).toBeNull();
  expect(await recordPauseQuiescence(db, w.original, observation)).toBe(1);
}, 30_000);

it("an observation of one original never stamps another original in the same pause scope", async () => {
  const w = await manual(false, true); await exit(w.child);
  const before = await receipts(w.agentId); expect(before).toHaveLength(2);
  expect(await recordPauseQuiescence(db, w.original)).toBe(1);
  const after = await receipts(w.agentId);
  expect(after.find(p => p.identity.heartbeatRunId === w.id)?.stopped?.heartbeatRunId).toBe(w.id);
  const other = before.find(p => p.identity.heartbeatRunId !== w.id)!;
  expect(after.find(p => p.id === other.id)).toEqual(other);
}, 30_000);

it("termination preserves invalidation and cannot gain a resumable stop proof", async () => {
  const w = await manual(false); await exit(w.child);
  await w.service.terminateAgent(w.agentId);
  const before = await receipts(w.agentId); expect(before[0].invalidated?.cause).toBe("terminate");
  expect(await recordPauseQuiescence(db, w.original)).toBe(0);
  expect(await receipts(w.agentId)).toEqual(before);
}, 30_000);
