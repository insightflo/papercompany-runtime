import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, costEvents, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { budgetService } from "../services/budgets.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isProcessAlive } from "../services/heartbeat-process-liveness.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
const ownedPids = new Set<number>();
const exitedPids = new Set<number>();
const ownedServers: Array<Awaited<ReturnType<typeof f.startServer>>> = [];
const fixtures: Array<{ starts: () => Promise<Array<{ pid: number }>> }> = [];
beforeAll(async () => { f = await startRuntimeShutdownProcessFixture(); }, 120_000);
afterAll(async () => {
  for (const server of ownedServers) { server.signal("SIGKILL"); await server.waitExit(); }
  for (const fixture of fixtures) for (const start of await fixture.starts()) if (!exitedPids.has(start.pid)) ownedPids.add(start.pid);
  for (const pid of ownedPids) if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  await f?.cleanup();
}, 120_000);

async function seedCompany() {
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
  const marker = path.join(f.root, `budget-${runId}.jsonl`), release = path.join(f.root, `budget-${runId}.release`);
  const script = path.join(f.root, `budget-${runId}.mjs`);
  await writeFile(script, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})+'\\n');
setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){console.log('completed');process.exit(0)}},50);`);
  await f.db.insert(companies).values({ id: companyId, name: "Budget acceptance", issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 7)}` });
  await f.db.insert(agents).values({ id: agentId, companyId, name: "Budget worker", status: "idle", adapterType: "process",
    adapterConfig: { command: process.execPath, args: [script], cwd: f.root }, runtimeConfig: {} });
  await f.db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", status: "queued", runId });
  await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", invocationSource: "on_demand",
    wakeupRequestId: wakeId, contextSnapshot: { taskKey: `budget-${runId}` } });
  const starts = async () => {
    try { return (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const fixture = { companyId, agentId, runId, wakeId, release, starts };
  fixtures.push(fixture);
  return fixture;
}

it("applies a real company hard stop during concurrent cancellation without stopping another company", async () => {
  const a = await seedCompany(), b = await seedCompany();
  const server = await f.startServer(undefined, { HEARTBEAT_SCHEDULER_ENABLED: "true" });
  ownedServers.push(server);
  const [aPid, bPid] = await Promise.all([a, b].map(input => f.waitFor(async () => {
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const starts = await input.starts();
    if (starts[0]?.pid) ownedPids.add(starts[0].pid);
    return run?.status === "running" && starts[0]?.pid ? starts[0].pid : null;
  }, "budget fixture child started", 60_000)));
  const recordedPids = await Promise.all([a, b].map(async input =>
    (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)))[0]?.processPid ?? null));
  console.info("T16A_M08_PID_OBSERVATION", JSON.stringify({ childPids: [aPid, bPid], recordedPids }));
  await f.waitFor(async () => {
    const [first, second] = await Promise.all([a, b].map(async input =>
      (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)))[0]?.processPid));
    return first === aPid && second === bPid ? true : null;
  }, "process adapter PIDs persisted", 4_000);
  expect(isProcessAlive(aPid)).toBe(true); expect(isProcessAlive(bPid)).toBe(true);
  await f.db.insert(costEvents).values({ companyId: a.companyId, agentId: a.agentId, provider: "local-test", model: "local-test",
    costCents: 2, occurredAt: new Date() });
  const heartbeat = heartbeatService(f.db);
  const budget = budgetService(f.db, { cancelWorkForScope: heartbeat.cancelBudgetScopeWork });
  const gate = await f.db.$client.reserve();
  await gate`begin`;
  const [{ pid: gatePid }] = await gate`select pg_backend_pid() as pid`;
  await gate`select id from heartbeat_runs where id = ${a.runId}::uuid for update`;
  let held = true;
  const pending = [
    budget.upsertPolicy(a.companyId, { scopeType: "company", scopeId: a.companyId, amount: 1, notifyEnabled: false }, null),
    heartbeat.cancelRun(a.runId),
  ];
  let settledCount = 0;
  pending.forEach(promise => void promise.then(() => { settledCount++; }, () => { settledCount++; }));
  let actions: PromiseSettledResult<unknown>[];
  try {
    await f.waitFor(async () => {
      const rows = await f.db.$client`select pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
      return rows.some(row => (row.blockers as number[]).includes(Number(gatePid))) ? true : null;
    }, "budget cancellation held at real row lock", 30_000);
    expect(settledCount).toBe(0);
    expect(isProcessAlive(aPid)).toBe(true);
    await gate`commit`; held = false;
    actions = await Promise.allSettled(pending);
  } finally {
    if (held) await gate`rollback`;
    await Promise.allSettled(pending);
    gate.release();
  }
  console.info("T16A_M08_ACTION_OBSERVATION", JSON.stringify({ actions: actions.map(action => {
    if (action.status === "fulfilled") return { status: action.status };
    const error = action.reason as { name?: string; message?: string; status?: number; code?: string };
    return { status: action.status, name: error?.name, message: error?.message, httpStatus: error?.status, code: error?.code };
  }), aAlive: isProcessAlive(aPid), bAlive: isProcessAlive(bPid) }));
  expect(actions.filter(action => action.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  for (const action of actions) {
    if (action.status === "fulfilled") continue;
    // A concurrent winner may change the observed scope; only this exact
    // fail-closed conflict is acceptable before the actual work has drained.
    expect(action.reason).toMatchObject({ status: 409, message: "heartbeat_pause_invalidation_scope_changed" });
  }
  await f.waitFor(async () => !isProcessAlive(aPid) ? true : null, "budget-stopped child exited", 30_000);
  ownedPids.delete(aPid); exitedPids.add(aPid);
  const [aRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
  const [aWake] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, a.wakeId));
  const [aCompany] = await f.db.select().from(companies).where(eq(companies.id, a.companyId));
  const [bCompany] = await f.db.select().from(companies).where(eq(companies.id, b.companyId));
  expect(aRun?.status).toBe("cancelled"); expect(aWake?.status).toBe("cancelled");
  expect(aCompany).toMatchObject({ status: "paused", pauseReason: "budget" });
  expect(bCompany?.status).not.toBe("paused"); expect(isProcessAlive(bPid)).toBe(true);
  await expect(heartbeat.wakeup(a.agentId, { source: "on_demand", reason: "budget acceptance replay" }))
    .rejects.toMatchObject({ status: 409, details: { scopeType: "company", scopeId: a.companyId } });
  await writeFile(b.release, "continue");
  await f.waitFor(async () => (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, b.runId)))[0]?.status === "succeeded" ? true : null,
    "unaffected company completed", 60_000);
  ownedPids.delete(bPid); exitedPids.add(bPid);
  server.signal("SIGTERM"); expect((await server.waitExit()).code).toBe(0);
  // Server exit drains its actual adapter execution and finalizers before retry.
  for (const [index, action] of actions.entries()) {
    if (action.status === "fulfilled") continue;
    if (index === 0) await budget.upsertPolicy(a.companyId,
      { scopeType: "company", scopeId: a.companyId, amount: 1, notifyEnabled: false }, null);
    else await heartbeat.cancelRun(a.runId);
  }
  expect((await f.db.select().from(companies).where(eq(companies.id, a.companyId)))[0])
    .toMatchObject({ status: "paused", pauseReason: "budget" });
  expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)))[0]?.status).toBe("cancelled");
  const restarted = await f.startServer(undefined, { HEARTBEAT_SCHEDULER_ENABLED: "true" });
  ownedServers.push(restarted);
  restarted.signal("SIGTERM"); expect((await restarted.waitExit()).code).toBe(0);
  expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, a.agentId))).toHaveLength(1);
  expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, b.agentId))).toHaveLength(1);
  expect(await a.starts()).toHaveLength(1); expect(await b.starts()).toHaveLength(1);
  f.recordEvidence("t16a-budget-cancel-isolation", restarted, { companyA: a.companyId, runA: a.runId, pidA: aPid,
    companyB: b.companyId, runB: b.runId, pidB: bPid, statusA: aRun?.status, statusB: "succeeded" });
}, 240_000);
