import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { activityLog, agentApiKeys, agents, agentWakeupRequests, companies, createDb,
  heartbeatRuns, instanceSettings, issues, missions, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { errorHandler } from "../middleware/error-handler.js";
import { readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, peer: Db;
const children = new Set<ChildProcess>(), trackedIds = new Set<string>();
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-control-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  await db.insert(instanceSettings).values({
    singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: false },
  });
}, 60_000);
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 3000 });
  }
  children.clear();
  for (const id of trackedIds) runningProcesses.delete(id);
  trackedIds.clear();
});
afterAll(async () => { await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup(); });

function app(board = true) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = board ? { type: "board", source: "local_implicit", userId: "board" } : { type: "none" };
    next();
  });
  instance.use("/api", agentRoutes(db)); instance.use(errorHandler);
  return instance;
}
async function seed() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05 control", issuePrefix: "C" + companyId.slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "running", permissions: {} });
  await db.insert(agentApiKeys).values({ agentId, companyId, name: "key", keyHash: randomUUID() });
  const w = { companyId, agentId };
  return { ...w, attempts: [await attempt(w), await attempt(w)] };
}
type World = Awaited<ReturnType<typeof seed>>;
async function attempt(w: { companyId: string; agentId: string }, status = "running") {
  const missionId = randomUUID(), issueId = randomUUID(), id = randomUUID(), wakeId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId: w.companyId, ownerAgentId: w.agentId, title: "mission" });
  await db.insert(issues).values({ id: issueId, companyId: w.companyId, missionId, title: "work",
    status: "in_progress", assigneeAgentId: w.agentId });
  await db.insert(agentWakeupRequests).values({ id: wakeId, ...w, missionId, issueId, source: "assignment",
    status: status === "running" ? "claimed" : status, runId: id });
  await db.insert(heartbeatRuns).values({ id, ...w, issueId, wakeupRequestId: wakeId, status,
    startedAt: status === "queued" ? null : new Date() });
  await db.update(issues).set({ executionRunId: id, checkoutRunId: id }).where(eq(issues.id, issueId));
  return { id, wakeId, issueId, missionId };
}
async function attach(a: World["attempts"][number], tracked: boolean) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.add(child); await once(child, "spawn");
  await db.update(heartbeatRuns).set({ processPid: child.pid! }).where(eq(heartbeatRuns.id, a.id));
  if (tracked) { runningProcesses.set(a.id, { child, graceSec: 1 }); trackedIds.add(a.id); }
  return child;
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function snapshot(w: World) {
  return {
    agent: (await peer.select().from(agents).where(eq(agents.id, w.agentId)))[0],
    keys: await peer.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, w.agentId)).orderBy(agentApiKeys.id),
    runs: await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId)).orderBy(heartbeatRuns.id),
    wakes: await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, w.agentId)).orderBy(agentWakeupRequests.id),
    issues: await peer.select().from(issues).where(eq(issues.assigneeAgentId, w.agentId)).orderBy(issues.id),
  };
}
async function controls(w: World) {
  return (await peer.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, w.agentId),
    eq(agentWakeupRequests.source, "internal_agent_pause_v1")))).map(readPauseControl);
}

// C05: adopted plan sections 1-3 require one save boundary, independent of the cancellation implementation.
// The same two-mission input previously changed agent status without a scope and could signal after partial saves.
it.each(["pause", "terminate"] as const)("route %s commits exact targets before tracked/recorded signals", async method => {
  const w = await seed(), foreign = await seed(), terminal = await attempt(w, "succeeded");
  const tracked = await attach(w.attempts[0], true), recorded = await attach(w.attempts[1], false);
  const unrelated = await attach(foreign.attempts[0], true), finished = await attach(terminal, true);
  const before = await snapshot(w), foreignBefore = await snapshot(foreign);
  const kill = vi.spyOn(tracked, "kill"), processKill = vi.spyOn(process, "kill");
  onTestFinished(() => { kill.mockRestore(); processKill.mockRestore(); });
  const signalCalls = () => processKill.mock.calls.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL");
  const transact = db.transaction.bind(db), transaction = vi.spyOn(db, "transaction");
  onTestFinished(() => transaction.mockRestore());
  let checked = false;
  transaction.mockImplementationOnce(((callback, config) => transact(async tx => {
    const result = await callback(tx);
    // Real PostgreSQL callback finished, but COMMIT has not occurred; peer sees the original complete state.
    expect(await snapshot(w)).toEqual(before);
    expect(kill).not.toHaveBeenCalled(); expect(signalCalls()).toEqual([]);
    checked = true;
    return result;
  }, config)) as Db["transaction"]);
  const response = await request(app()).post(`/api/agents/${w.agentId}/${method}`);
  transaction.mockRestore();
  expect(response.status).toBe(200); expect(checked).toBe(true);
  expect(response.body).toMatchObject({ id: w.agentId, status: method === "pause" ? "paused" : "terminated",
    urlKey: "worker", defaultParentIssueId: null });
  expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(signalCalls()).toEqual([[recorded.pid, "SIGTERM"]]);
  for (const child of [tracked, recorded]) await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 3000 });
  expect(alive(unrelated.pid!)).toBe(true); expect(alive(finished.pid!)).toBe(true);
  const saved = await snapshot(w), records = await controls(w);
  const scope = records.find(p => p.kind === "scope")!, receipts = records.filter((p): p is PauseReceipt => p.kind === "receipt");
  expect(records.find(p => p.kind === "head")).toMatchObject({ scopeId: scope.id });
  expect(scope.cause).toBe(method === "pause" ? "manual_pause" : "terminate");
  expect(scope.receiptIds.slice().sort()).toEqual(receipts.map(p => p.id).sort());
  expect(receipts).toHaveLength(2);
  for (const a of w.attempts) {
    expect(receipts.find(p => p.identity.heartbeatRunId === a.id)).toMatchObject({
      ownerScopeId: scope.id, originScopeId: scope.id, cause: method === "pause" ? "manual_pause" : "terminate",
      identity: { missionId: a.missionId, issueId: a.issueId, wakeupRequestId: a.wakeId },
      resumeScopeId: null, delivery: null, stopped: null,
      invalidated: method === "pause" ? null : { cause: "terminate" },
    });
    expect(saved.runs.find(r => r.id === a.id)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(saved.wakes.find(r => r.id === a.wakeId)).toMatchObject({ status: "cancelled", runId: a.id });
    expect(saved.issues.find(i => i.id === a.issueId)).toMatchObject({ executionRunId: null, checkoutRunId: null });
  }
  expect(saved.runs.find(r => r.id === terminal.id)).toEqual(before.runs.find(r => r.id === terminal.id));
  expect(saved.wakes.find(r => r.id === terminal.wakeId)).toEqual(before.wakes.find(r => r.id === terminal.wakeId));
  expect(saved.issues.find(r => r.id === terminal.issueId)).toEqual(before.issues.find(r => r.id === terminal.issueId));
  expect(saved.keys[0].revokedAt).toEqual(method === "pause" ? null : expect.any(Date));
  expect(await snapshot(foreign)).toEqual(foreignBefore);
  expect(await peer.select().from(activityLog).where(and(eq(activityLog.entityId, w.agentId),
    eq(activityLog.action, method === "pause" ? "agent.paused" : "agent.terminated")))).toHaveLength(1);
}, 30_000);

it.each([
  ["pause", "error"], ["pause", "run_miss"], ["pause", "wake_miss"], ["pause", "agent_miss"],
  ["terminate", "error"], ["terminate", "run_miss"], ["terminate", "wake_miss"],
  ["terminate", "agent_miss"], ["terminate", "key_miss"],
] as const)("%s rolls back status, scope, cancellation and keys on %s", async (method, fault) => {
  const w = await seed(), child = await attach(w.attempts[0], true);
  const recorded = await attach(w.attempts[1], false), before = await snapshot(w);
  const kill = vi.spyOn(child, "kill"), processKill = vi.spyOn(process, "kill");
  onTestFinished(() => { kill.mockRestore(); processKill.mockRestore(); });
  const last = w.attempts.map(a => a.id).sort().at(-1)!;
  const table = fault === "agent_miss" ? "agents" : fault === "key_miss" ? "agent_api_keys"
    : fault === "error" || fault === "wake_miss" ? "agent_wakeup_requests" : "heartbeat_runs";
  const target = table === "agents" ? `OLD.id='${w.agentId}'` : `OLD.agent_id='${w.agentId}'`;
  const condition = table === "agent_wakeup_requests" ? ` AND OLD.run_id='${last}'`
    : table === "heartbeat_runs" ? ` AND OLD.id='${last}'` : "";
  await db.$client.unsafe(`CREATE FUNCTION c05_control_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${target}${condition} THEN ${fault === "error" ? "RAISE EXCEPTION 'c05 middle write';" : "RETURN NULL;"}
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER c05_control_failure BEFORE UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION c05_control_failure()`);
  try {
    const response = await request(app()).post(`/api/agents/${w.agentId}/${method}`);
    expect(response.status).toBe(fault === "error" ? 500 : 409);
  } finally {
    await db.$client.unsafe(`DROP TRIGGER c05_control_failure ON ${table}; DROP FUNCTION c05_control_failure()`);
  }
  expect(await snapshot(w)).toEqual(before);
  expect(kill).not.toHaveBeenCalled();
  expect(processKill.mock.calls.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL")).toEqual([]);
  expect(alive(child.pid!)).toBe(true); expect(alive(recorded.pid!)).toBe(true);
  expect(runningProcesses.has(w.attempts[0].id)).toBe(true);
  expect(await controls(w)).toHaveLength(0);
  expect(await peer.select().from(activityLog).where(eq(activityLog.entityId, w.agentId))).toHaveLength(0);
}, 30_000);

it("repeated pause creates a new scope; terminate invalidates even cancelled pending originals", async () => {
  const w = await seed(), service = heartbeatService(db);
  await service.pauseAgent(w.agentId);
  const first = await controls(w), head = first.find(p => p.kind === "head")!;
  const originals = first.filter((p): p is PauseReceipt => p.kind === "receipt");
  for (const p of originals) await db.update(agentWakeupRequests).set({ payload: { ...p, resumeScopeId: head.scopeId } })
    .where(eq(agentWakeupRequests.id, p.id));
  await service.pauseAgent(w.agentId);
  const second = await controls(w), next = second.find(p => p.kind === "head")!;
  expect(next.scopeId).not.toBe(head.scopeId);
  for (const p of originals) expect(second.find(r => r.id === p.id)).toMatchObject({
    ownerScopeId: next.scopeId, originScopeId: head.scopeId, resumeScopeId: head.scopeId, invalidated: null,
  });
  await service.terminateAgent(w.agentId);
  const final = await controls(w), current = final.find(p => p.kind === "head")!;
  expect(current.scopeId).not.toBe(next.scopeId);
  for (const p of originals) expect(final.find(r => r.id === p.id)).toMatchObject({
    ownerScopeId: current.scopeId, originScopeId: head.scopeId, resumeScopeId: head.scopeId,
    invalidated: { cause: "terminate" }, delivery: null, stopped: null,
  });
  expect(final.filter(p => p.kind === "receipt")).toHaveLength(2);
  const saved = await snapshot(w);
  expect(saved.runs).toHaveLength(2);
  expect(saved.wakes.filter(r => r.source !== "internal_agent_pause_v1")).toHaveLength(2);
  expect(saved.keys[0].revokedAt).toBeInstanceOf(Date);
});

it("a newly discovered active target aborts without signalling the stale target set", async () => {
  const w = await seed(), child = await attach(w.attempts[0], true);
  const kill = vi.spyOn(child, "kill"); onTestFinished(() => kill.mockRestore());
  let release!: () => void, ready!: () => void, blockerPid = 0;
  const gate = new Promise<void>(r => { release = r; }), holding = new Promise<void>(r => { ready = r; });
  const blocker = peer.transaction(async tx => {
    blockerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
    await tx.select().from(missions).where(eq(missions.id, w.attempts[0].missionId)).for("no key update");
    ready(); await gate;
  });
  await holding;
  const pending = heartbeatService(db).pauseAgent(w.agentId), outcome = Promise.allSettled([pending]);
  let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
  try {
    await vi.waitFor(async () => {
      const rows = await db.$client.unsafe(
        "select pid from pg_stat_activity where $1::int = ANY(pg_blocking_pids(pid))", [blockerPid]);
      expect(rows.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
    await attempt(w);
    expected = await snapshot(w);
  } finally { release(); await blocker; await outcome; }
  const [result] = await outcome;
  expect(result.status).toBe("rejected"); expect(kill).not.toHaveBeenCalled();
  expect(alive(child.pid!)).toBe(true); expect(await controls(w)).toHaveLength(0);
  const saved = await snapshot(w);
  expect(saved).toEqual(expected);
  expect(saved.agent?.status).toBe("running"); expect(saved.keys[0].revokedAt).toBeNull();
  expect(saved.runs.map(r => r.status)).toEqual(["running", "running", "running"]);
  expect(saved.issues.every(i => i.executionRunId !== null)).toBe(true);
}, 30_000);

it("routes retain board rejection, missing 404 and terminated pause rejection", async () => {
  const w = await seed(), before = await snapshot(w);
  expect((await request(app(false)).post(`/api/agents/${w.agentId}/pause`)).status).toBe(403);
  for (const method of ["pause", "terminate"]) {
    expect((await request(app()).post(`/api/agents/${randomUUID()}/${method}`)).status).toBe(404);
  }
  expect(await snapshot(w)).toEqual(before);
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, w.agentId));
  const terminated = await snapshot(w);
  const response = await request(app()).post(`/api/agents/${w.agentId}/pause`);
  expect(response.status).toBe(409); expect(response.body.error).toBe("Cannot pause terminated agent");
  expect(await snapshot(w)).toEqual(terminated); expect(await controls(w)).toHaveLength(0);
});
