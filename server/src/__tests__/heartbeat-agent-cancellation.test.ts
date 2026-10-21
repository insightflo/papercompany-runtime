import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents,
  heartbeatRuns, instanceSettings, issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const completed = {
  exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: null, runtimeServices: [],
};
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let root: string;
const children = new Set<ChildProcess>();
const agentIds = new Set<string>(), runIds = new Set<string>();
const releases: (() => void)[] = [];

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-agent-cancellation-");
  db = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-agent-cancellation-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({
    singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: false },
  });
}, 60000);
beforeEach(() => { adapter.mockReset().mockResolvedValue(completed); });
afterEach(async () => {
  if (agentIds.size) await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  releases.splice(0).forEach(release => release());
  try {
    await waitForHeartbeatExecutionsToDrain(db);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await vi.waitFor(() => expect(isAlive(child.pid!)).toBe(false), { timeout: 3000 });
    }
    children.clear();
    for (const id of runIds) runningProcesses.delete(id);
  }
}, 60000);
afterAll(async () => {
  if (db) { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end({ timeout: 5 }); }
  await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 60000);

type World = { companyId: string; agentId: string };
async function world(status = "paused"): Promise<World> {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Cancellation", issuePrefix: randomUUID() });
  await db.insert(agents).values({
    id: agentId, companyId, name: "Worker", status, adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Isolated cancellation test" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
  });
  agentIds.add(agentId);
  return { companyId, agentId };
}
async function seed(w: World, status: string, linked = false, pid: number | null = null) {
  const id = randomUUID(), wakeId = randomUUID(), issueId = linked ? randomUUID() : null;
  const terminal = !["queued", "running"].includes(status);
  if (issueId) await db.insert(issues).values({
    id: issueId, companyId: w.companyId, title: "Cancellation ownership",
    status: "in_progress", assigneeAgentId: w.agentId,
  });
  await db.insert(agentWakeupRequests).values({
    id: wakeId, ...w, source: "assignment", triggerDetail: "system", reason: "issue_assigned",
    status: status === "running" ? "claimed" : status, runId: id,
    payload: issueId ? { issueId } : {}, finishedAt: terminal ? new Date() : null,
  });
  await db.insert(heartbeatRuns).values({
    id, ...w, issueId, wakeupRequestId: wakeId, invocationSource: "assignment", triggerDetail: "system",
    status, processPid: pid, startedAt: status === "queued" ? null : new Date(),
    finishedAt: terminal ? new Date() : null, error: terminal ? "original terminal result" : null,
    contextSnapshot: issueId ? { issueId } : {},
  });
  if (issueId) await db.update(issues).set({ checkoutRunId: id, executionRunId: id }).where(eq(issues.id, issueId));
  runIds.add(id);
  return { id, wakeId, issueId, ...w };
}
const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const readWake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
const readAgent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
const cancelEvents = (id: string) => db.select().from(heartbeatRunEvents).where(and(
  eq(heartbeatRunEvents.runId, id), eq(heartbeatRunEvents.message, "run cancelled"),
));
function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function liveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.add(child);
  await once(child, "spawn");
  expect(isAlive(child.pid!)).toBe(true);
  return child;
}
async function expectCancelled(f: Awaited<ReturnType<typeof seed>>, reason: string) {
  expect(await readRun(f.id)).toMatchObject({
    status: "cancelled", errorCode: "cancelled", error: reason, finishedAt: expect.any(Date),
  });
  expect(await readWake(f.wakeId)).toMatchObject({
    status: "cancelled", error: reason, finishedAt: expect.any(Date), runId: f.id,
  });
}

// C05 prelude/C12: these public-call inputs also run against the pre-extraction service.
// Existing independent expectations: heartbeat-process-recovery.test.ts:370-391,499-521.
it.each(["recorded", "tracked"] as const)("public cancelRun releases its owner and stops a %s process", async kind => {
  const w = await world(), child = await liveChild(), f = await seed(w, "running", true, child.pid!);
  const queued = await seed(w, "queued");
  if (kind === "tracked") runningProcesses.set(f.id, { child, graceSec: 1 });
  const result = await heartbeatService(db).cancelRun(f.id);
  await expectCancelled(f, "Cancelled by control plane");
  expect(result).toEqual(await readRun(f.id));
  await vi.waitFor(() => expect(isAlive(child.pid!)).toBe(false), { timeout: 3000 });
  expect(runningProcesses.has(f.id)).toBe(false);
  expect(await readIssue(f.issueId!)).toMatchObject({
    status: "blocked", checkoutRunId: null, executionRunId: null,
  });
  expect(await heartbeatService(db).cancelRun(f.id)).toEqual(result);
  expect(await cancelEvents(f.id)).toHaveLength(1);
  expect((await readRun(queued.id)).status).toBe("queued");
  expect((await readWake(queued.wakeId)).status).toBe("queued");
  expect((await readAgent(w.agentId)).status).toBe("paused");
  expect(adapter).not.toHaveBeenCalled();
}, 30000);

it("public cancelRun preserves a newer owner's issue and locks", async () => {
  const w = await world(), stale = await seed(w, "running", true), owner = await seed(w, "running");
  await db.update(issues).set({ checkoutRunId: owner.id, executionRunId: owner.id }).where(eq(issues.id, stale.issueId!));
  const before = await readIssue(stale.issueId!);
  await heartbeatService(db).cancelRun(stale.id);
  await expectCancelled(stale, "Cancelled by control plane");
  expect(await readIssue(stale.issueId!)).toEqual(before);
  expect((await readRun(owner.id)).status).toBe("running");
  expect(adapter).not.toHaveBeenCalled();
}, 30000);

it.each(["recorded", "tracked"] as const)("public cancelActiveForAgent retains its bulk contract with a %s process", async kind => {
  const w = await world(), child = await liveChild();
  const active = await seed(w, "running", true, child.pid!), queued = await seed(w, "queued", true);
  const terminal = await seed(w, "succeeded"), foreign = await seed(await world(), "running", true);
  const untouched = [await readRun(terminal.id), await readWake(terminal.wakeId),
    await readRun(foreign.id), await readWake(foreign.wakeId), await readIssue(foreign.issueId!)];
  if (kind === "tracked") runningProcesses.set(active.id, { child, graceSec: 1 });
  expect(await heartbeatService(db).cancelActiveForAgent(w.agentId)).toBe(2);
  for (const f of [active, queued]) {
    await expectCancelled(f, "Cancelled due to agent pause");
    // Bulk release receives the original run, unlike single cancel's cancelled row.
    expect(await readIssue(f.issueId!)).toMatchObject({
      status: "in_progress", checkoutRunId: null, executionRunId: null,
    });
    expect(await cancelEvents(f.id)).toHaveLength(0);
  }
  await vi.waitFor(() => expect(isAlive(child.pid!)).toBe(false), { timeout: 3000 });
  expect(runningProcesses.has(active.id)).toBe(false);
  expect([await readRun(terminal.id), await readWake(terminal.wakeId),
    await readRun(foreign.id), await readWake(foreign.wakeId), await readIssue(foreign.issueId!)]).toEqual(untouched);
  expect(await heartbeatService(db).cancelActiveForAgent(w.agentId)).toBe(0);
  expect((await readAgent(w.agentId)).status).toBe("paused");
  expect(adapter).not.toHaveBeenCalled();
}, 30000);

it.each(["succeeded", "failed", "cancelled"])("repeated public cancelRun leaves a %s run and wake unchanged", async status => {
  const w = await world(), f = await seed(w, status, true);
  const before = [await readRun(f.id), await readWake(f.wakeId), await readIssue(f.issueId!), await readAgent(w.agentId)];
  const service = heartbeatService(db);
  expect(await service.cancelRun(f.id)).toEqual(before[0]);
  expect(await service.cancelRun(f.id)).toEqual(before[0]);
  expect([await readRun(f.id), await readWake(f.wakeId), await readIssue(f.issueId!), await readAgent(w.agentId)]).toEqual(before);
  expect(await cancelEvents(f.id)).toHaveLength(0);
  expect(adapter).not.toHaveBeenCalled();
}, 30000);

it("public single cancel advances an available agent's queue and drains the actual asynchronous execution", async () => {
  const w = await world("idle"), active = await seed(w, "running"), queued = await seed(w, "queued");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  adapter.mockImplementation(async () => { await held; return completed; });
  try {
    const result = await heartbeatService(db).cancelRun(active.id);
    expect(result?.status).toBe("cancelled");
    await expectCancelled(active, "Cancelled by control plane");
    await vi.waitFor(() => expect(adapter.mock.calls.map(([input]) => input.runId)).toEqual([queued.id]), { timeout: 10000 });
    expect((await readRun(queued.id)).status).toBe("running");
    expect((await readWake(queued.wakeId)).status).toBe("claimed");
    release();
    // Process exit above and completion of the service's async execution are separate checks.
    await waitForHeartbeatExecutionsToDrain(db);
    expect((await readRun(queued.id)).status).toBe("succeeded");
    expect(adapter).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await waitForHeartbeatExecutionsToDrain(db);
  }
}, 30000);
