import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  instanceSettings, issues, missions, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as intents from "../services/heartbeat-pause-intents.js";
import { readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, peer: Db;
const children = new Set<ChildProcess>(), tracked = new Set<string>();
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-resume-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  await db.insert(instanceSettings).values({
    singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: false },
  });
}, 60_000);
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 3000 });
  }
  children.clear();
  for (const id of tracked) runningProcesses.delete(id);
  tracked.clear();
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
  await db.insert(companies).values({ id: companyId, name: "C05 resume", issuePrefix: "R" + companyId.slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "running", permissions: {} });
  const attempts: { id: string; wakeId: string; issueId: string; missionId: string }[] = [];
  for (let n = 0; n < 2; n++) {
    const id = randomUUID(), wakeId = randomUUID(), issueId = randomUUID(), missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "mission" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "work",
      status: "in_progress", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, missionId, issueId,
      source: "assignment", status: "claimed", runId: id });
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, wakeupRequestId: wakeId,
      status: "running", startedAt: new Date() });
    await db.update(issues).set({ executionRunId: id, checkoutRunId: id }).where(eq(issues.id, issueId));
    attempts.push({ id, wakeId, issueId, missionId });
  }
  return { companyId, agentId, attempts };
}
type World = Awaited<ReturnType<typeof seed>>;
async function snapshot(w: World) {
  return {
    agent: (await peer.select().from(agents).where(eq(agents.id, w.agentId)))[0],
    runs: await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId)).orderBy(heartbeatRuns.id),
    wakes: await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, w.agentId)).orderBy(agentWakeupRequests.id),
    issues: await peer.select().from(issues).where(eq(issues.assigneeAgentId, w.agentId)).orderBy(issues.id),
  };
}
async function controls(w: World) {
  return (await snapshot(w)).wakes.filter(r => r.source === "internal_agent_pause_v1").map(readPauseControl);
}
const receipts = (rows: Awaited<ReturnType<typeof controls>>) => rows.filter((p): p is PauseReceipt => p.kind === "receipt");
async function resumedLogs(w: World) {
  return peer.select().from(activityLog).where(and(eq(activityLog.entityId, w.agentId), eq(activityLog.action, "agent.resumed")));
}
async function pause(w: World) {
  expect((await request(app()).post(`/api/agents/${w.agentId}/pause`)).status).toBe(200);
}

// C05 independent oracle: c05-minimum-plan-adopted.md:46-52 requires the current exact receipts
// AND agent resume in one save. Baseline's same pause -> resume input saves idle only, no approvals.
// These tests cover intent storage only; actual stop/admission/single delivery remain separate obligations.
it("one route resume atomically approves both missions; repeat preserves approvals and creates no followup", async () => {
  const w = await seed(), foreign = await seed();
  await pause(w);
  const before = await snapshot(w), foreignBefore = await snapshot(foreign), pending = await controls(w);
  const head = pending.find(p => p.kind === "head")!;
  expect(receipts(pending)).toHaveLength(2);
  expect(receipts(pending).every(p => p.resumeScopeId === null)).toBe(true);
  const transact = db.transaction.bind(db), transaction = vi.spyOn(db, "transaction");
  onTestFinished(() => transaction.mockRestore());
  let checked = false;
  transaction.mockImplementationOnce(((callback, config) => transact(async tx => {
    const result = await callback(tx);
    expect(await snapshot(w)).toEqual(before); // Peer cannot see either half before COMMIT.
    checked = true; return result;
  }, config)) as Db["transaction"]);
  const response = await request(app()).post(`/api/agents/${w.agentId}/resume`);
  transaction.mockRestore();
  expect(response.status).toBe(200); expect(checked).toBe(true);
  expect(response.body).toMatchObject({ id: w.agentId, status: "idle", pauseReason: null, pausedAt: null,
    urlKey: "worker", defaultParentIssueId: null });
  const saved = await snapshot(w), approved = await controls(w);
  expect(saved.agent).toMatchObject({ status: "idle", pausedAt: null, pauseReason: null });
  for (const a of w.attempts) expect(receipts(approved).find(p => p.identity.heartbeatRunId === a.id)).toMatchObject({
    ownerScopeId: head.scopeId, resumeScopeId: head.scopeId, invalidated: null, delivery: null, stopped: null,
    identity: { missionId: a.missionId, issueId: a.issueId, wakeupRequestId: a.wakeId },
  });
  expect(saved.runs).toEqual(before.runs); expect(saved.issues).toEqual(before.issues);
  expect(saved.wakes.map(r => r.id)).toEqual(before.wakes.map(r => r.id));
  expect(await resumedLogs(w)).toHaveLength(1);
  expect((await request(app()).post(`/api/agents/${w.agentId}/resume`)).status).toBe(200);
  const repeated = await snapshot(w);
  expect(repeated.wakes).toEqual(saved.wakes); expect(repeated.runs).toEqual(saved.runs);
  expect(await controls(w)).toEqual(approved); expect(await snapshot(foreign)).toEqual(foreignBefore);
});

it("resume before actual termination preserves intent and starts no replacement", async () => {
  const w = await seed(), a = w.attempts[0];
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  children.add(child); await once(child.stdout!, "data");
  runningProcesses.set(a.id, { child, graceSec: 1 }); tracked.add(a.id);
  await db.update(heartbeatRuns).set({ processPid: child.pid! }).where(eq(heartbeatRuns.id, a.id));
  await pause(w);
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  const before = await snapshot(w);
  expect((await request(app()).post(`/api/agents/${w.agentId}/resume`)).status).toBe(200);
  const rows = await controls(w), head = rows.find(p => p.kind === "head")!;
  expect(receipts(rows).every(p => p.resumeScopeId === head.scopeId && p.delivery === null && p.stopped === null)).toBe(true);
  expect((await snapshot(w)).runs).toEqual(before.runs);
  expect((await snapshot(w)).wakes.map(r => r.id)).toEqual(before.wakes.map(r => r.id));
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
}, 30_000);

it("a pause replacing the observed scope rejects the older in-flight resume", async () => {
  const w = await seed(); await pause(w);
  expect((await request(app()).post(`/api/agents/${w.agentId}/resume`)).status).toBe(200);
  const first = await controls(w), oldHead = first.find(p => p.kind === "head")!;
  const lock = intents.lockPauseFacts, spy = vi.spyOn(intents, "lockPauseFacts");
  onTestFinished(() => spy.mockRestore());
  let replaced: Awaited<ReturnType<typeof snapshot>> | undefined;
  // Deterministic scheduling only: the second connection performs a real pause between observation and locks.
  spy.mockImplementationOnce(async (tx, input) => {
    await heartbeatService(peer).pauseAgent(w.agentId);
    replaced = await snapshot(w);
    return lock(tx, input);
  });
  const response = await request(app()).post(`/api/agents/${w.agentId}/resume`);
  spy.mockRestore();
  expect(response.status).toBe(409); expect(response.body.error).toBe("heartbeat_pause_scope_unproven_or_changed");
  expect(replaced).toBeDefined(); expect(await snapshot(w)).toEqual(replaced);
  const next = await controls(w), head = next.find(p => p.kind === "head")!;
  expect(head.scopeId).not.toBe(oldHead.scopeId);
  expect(receipts(next)).toHaveLength(2);
  expect(receipts(next).every(p => p.ownerScopeId === head.scopeId && p.originScopeId === oldHead.scopeId && p.resumeScopeId === oldHead.scopeId)).toBe(true);
  expect(await resumedLogs(w)).toHaveLength(1);
  expect((await request(app()).post(`/api/agents/${w.agentId}/resume`)).status).toBe(200);
  expect(receipts(await controls(w)).every(p => p.resumeScopeId === head.scopeId)).toBe(true);
});

it.each(["receipt_error", "receipt_miss", "agent_error", "agent_miss"] as const)(
  "resume rolls back both approvals and state on %s", async fault => {
    const w = await seed(); await pause(w);
    const before = await snapshot(w), rows = await controls(w);
    const last = receipts(rows).map(p => p.id).sort().at(-1)!;
    const agentFault = fault.startsWith("agent"), table = agentFault ? "agents" : "agent_wakeup_requests";
    const target = agentFault ? w.agentId : last;
    await db.$client.unsafe(`CREATE FUNCTION c05_resume_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id='${target}' THEN ${fault.endsWith("error") ? "RAISE EXCEPTION 'c05 resume middle write';" : "RETURN NULL;"}
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER c05_resume_failure BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION c05_resume_failure()`);
    try {
      const response = await request(app()).post(`/api/agents/${w.agentId}/resume`);
      expect(response.status).toBe(fault.endsWith("error") ? 500 : 409);
    } finally {
      await db.$client.unsafe(`DROP TRIGGER c05_resume_failure ON ${table}; DROP FUNCTION c05_resume_failure()`);
    }
    expect(await snapshot(w)).toEqual(before);
    expect(await resumedLogs(w)).toHaveLength(0);
  },
);

it("resume preserves invalidation and an already delivered exact connection", async () => {
  const w = await seed(); await pause(w);
  const rows = await controls(w), head = rows.find(p => p.kind === "head")!, [invalid, delivered] = receipts(rows);
  const wakeId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: w.companyId, agentId: w.agentId,
    issueId: delivered.identity.issueId, missionId: delivered.identity.missionId, source: "automation", status: "skipped" });
  await db.update(agentWakeupRequests).set({ payload: { ...invalid,
    invalidated: { cause: "user_cancel", at: new Date().toISOString() } } }).where(eq(agentWakeupRequests.id, invalid.id));
  await db.update(agentWakeupRequests).set({ payload: { ...delivered, resumeScopeId: head.scopeId,
    delivery: { wakeupRequestId: wakeId, heartbeatRunId: null } } }).where(eq(agentWakeupRequests.id, delivered.id));
  const before = await snapshot(w);
  expect((await request(app()).post(`/api/agents/${w.agentId}/resume`)).status).toBe(200);
  const saved = await snapshot(w);
  expect(saved.wakes).toEqual(before.wakes); expect(saved.runs).toEqual(before.runs);
  expect(saved.agent?.status).toBe("idle");
});

it("headless legacy pause resumes ordinarily; public lookalike records never supply pause targets", async () => {
  const w = await seed(), fakeId = randomUUID();
  await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, w.agentId));
  await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled" }).where(eq(heartbeatRuns.agentId, w.agentId));
  await db.insert(agentWakeupRequests).values({ id: fakeId, companyId: w.companyId, agentId: w.agentId,
    source: "on_demand", requestedByActorType: "user", requestedByActorId: "board",
    requestKind: "agent_pause_control_v1", status: "skipped", payload: {
      schemaVersion: 1, kind: "head", id: fakeId, companyId: w.companyId, agentId: w.agentId, scopeId: null,
    } });
  const before = await snapshot(w), response = await request(app()).post(`/api/agents/${w.agentId}/resume`);
  expect(response.status).toBe(200); expect(response.body.status).toBe("idle");
  const saved = await snapshot(w);
  expect(saved.wakes).toEqual(before.wakes); expect(saved.runs).toEqual(before.runs);
  expect(await controls(w)).toHaveLength(0); expect(await resumedLogs(w)).toHaveLength(1);
});

it("resume retains board permission, missing 404 and terminated/pending approval refusal", async () => {
  const w = await seed(), before = await snapshot(w);
  expect((await request(app(false)).post(`/api/agents/${w.agentId}/resume`)).status).toBe(403);
  expect((await request(app()).post(`/api/agents/${randomUUID()}/resume`)).status).toBe(404);
  expect(await snapshot(w)).toEqual(before);
  for (const [status, error] of [["terminated", "Cannot resume terminated agent"],
    ["pending_approval", "Pending approval agents cannot be resumed"]]) {
    await db.update(agents).set({ status }).where(eq(agents.id, w.agentId));
    const stopped = await snapshot(w), response = await request(app()).post(`/api/agents/${w.agentId}/resume`);
    expect(response.status).toBe(409); expect(response.body.error).toBe(error);
    expect(await snapshot(w)).toEqual(stopped);
  }
  expect(await controls(w)).toHaveLength(0); expect(await resumedLogs(w)).toHaveLength(0);
});
