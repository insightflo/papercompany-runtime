import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, costEvents, createDb, heartbeatRuns, instanceSettings,
  issues, missions, projects, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { heartbeatService } from "../services/heartbeat.js";
import { budgetService } from "../services/budgets.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import * as delivery from "../services/heartbeat-pause-delivery.js";
import * as recovery from "../services/heartbeat-recovery-guard.js";
import * as live from "../services/live-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const completed = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let db: Db, peer: Db, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, root: string;
const agentIds = new Set<string>(), holds = new Map<string, ReturnType<typeof gate>>(), releases = new Set<() => void>();
let starts: string[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.add(release); return { promise, release };
}
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-invalidation-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-c05-invalidation-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({ singletonKey: "default",
    experimental: { enableHeartbeatFinalizationV1: false } });
}, 60_000);
beforeEach(() => {
  starts = [];
  adapter.mockImplementation(async (ctx: AdapterExecutionContext) => {
    starts.push(ctx.runId); const held = gate(); holds.set(ctx.runId, held); await held.promise; return completed;
  });
});
async function drain() {
  await waitForHeartbeatExecutionsToDrain(db); await waitForHeartbeatExecutionsToDrain(peer);
}
afterEach(async () => {
  if (agentIds.size) await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  vi.restoreAllMocks(); for (const release of releases) release();
  await drain(); holds.clear(); releases.clear(); agentIds.clear(); adapter.mockReset();
}, 60_000);
afterAll(async () => {
  await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
}, 60_000);
async function world(companyId?: string) {
  companyId ??= randomUUID();
  if (!(await db.select().from(companies).where(eq(companies.id, companyId))).length)
    await db.insert(companies).values({ id: companyId, name: "C05 invalidation", issuePrefix: randomUUID() });
  const agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Isolated cancellation test" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } });
  agentIds.add(agentId); return { companyId, agentId };
}
async function work(w: Awaited<ReturnType<typeof world>>) {
  const projectId = randomUUID(), missionId = randomUUID(), issueId = randomUUID();
  await db.insert(projects).values({ id: projectId, companyId: w.companyId, name: "scope" });
  await db.insert(missions).values({ id: missionId, companyId: w.companyId, ownerAgentId: w.agentId,
    projectId, title: "independent mission", status: "running" });
  await db.insert(issues).values({ id: issueId, companyId: w.companyId, projectId, missionId,
    title: "C05 work", status: "in_progress", assigneeAgentId: w.agentId });
  const parent = await heartbeatService(db).wakeup(w.agentId, { source: "on_demand", triggerDetail: "manual",
    reason: "c05_invalidation", payload: { issueId, projectId }, contextSnapshot: { issueId, projectId, missionId } });
  expect(parent).not.toBeNull();
  await vi.waitFor(() => expect(starts).toContain(parent!.id), { timeout: 10_000 });
  return { ...w, projectId, missionId, issueId, parent: (await readRun(parent!.id))! };
}
type Work = Awaited<ReturnType<typeof work>>;
const readRun = async (id: string) => (await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
const readWake = async (id: string) => (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
async function receipts(agentId: string) {
  return (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
    .filter(r => r.source === "internal_agent_pause_v1").map(readPauseControl)
    .filter((p): p is PauseReceipt => p.kind === "receipt");
}
async function receipt(w: Work) {
  return (await receipts(w.agentId)).find(p => p.identity.heartbeatRunId === w.parent.id)!;
}
async function pause(...works: Work[]) {
  for (const agentId of new Set(works.map(w => w.agentId))) {
    await heartbeatService(db).pauseAgent(agentId); await heartbeatService(db).resumeAgent(agentId);
  }
}
async function retain(...works: Work[]) {
  const failed = vi.spyOn(delivery, "deliverPauseResume").mockRejectedValue(new Error("delivery temporarily unavailable"));
  try { for (const w of works) holds.get(w.parent.id)!.release(); await drain(); } finally { failed.mockRestore(); }
  for (const w of works) {
    const p = await receipt(w); expect(p.stopped?.heartbeatRunId).toBe(w.parent.id);
    expect(p.resumeScopeId).toBe(p.ownerScopeId); expect(p.delivery).toBeNull();
  }
}
async function queued(w: Work) {
  const child = await delivery.deliverPauseResume(db, (await receipt(w)).id);
  expect(child).toMatchObject({ status: "queued", retryOfRunId: w.parent.id });
  return child!;
}
async function noRevival(w: Work) {
  await heartbeatService(peer).resumeQueuedRuns(); await drain();
  await heartbeatService(db).pauseAgent(w.agentId); await heartbeatService(db).resumeAgent(w.agentId);
  await heartbeatService(peer).resumeQueuedRuns(); await drain();
  const rows = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId));
  expect(rows.filter(h => h.retryOfRunId === w.parent.id && h.status !== "cancelled")).toHaveLength(0);
  expect((await receipt(w)).invalidated).not.toBeNull();
}

// C05/C12 oracle: adopted plan requires cancel/budget to revoke even a manual_pause terminal original.
// All control, approval, stop and delivery records below come from real public services/finally writers.
it("single cancel revokes only its paused mission before late finally and preserves another mission", async () => {
  const w = await world(), a = await work(w), b = await work(w);
  await pause(a, b);
  const before = [await readRun(a.parent.id), await readWake(a.parent.wakeupRequestId!)];
  expect(await heartbeatService(peer).cancelRun(a.parent.id)).toEqual(before[0]);
  expect([await readRun(a.parent.id), await readWake(a.parent.wakeupRequestId!)]).toEqual(before);
  expect((await receipt(a)).invalidated?.cause).toBe("user_cancel");
  expect((await receipt(b)).invalidated).toBeNull();
  holds.get(a.parent.id)!.release(); holds.get(b.parent.id)!.release();
  await vi.waitFor(async () => {
    const p = await receipt(b); expect(p.delivery?.heartbeatRunId).toBeTruthy();
    expect(starts).toContain(p.delivery!.heartbeatRunId!);
  }, { timeout: 10_000 });
  expect((await receipt(a)).delivery).toBeNull();
  const child = (await receipt(b)).delivery!.heartbeatRunId!;
  holds.get(child)!.release(); await drain(); await noRevival(a);
  expect(starts.filter(id => id !== a.parent.id && id !== b.parent.id)).toEqual([child]);
}, 30_000);

it("bulk cancel includes control-only pending intent and repeated cancel stays unchanged", async () => {
  const a = await work(await world()); await pause(a);
  expect(await heartbeatService(peer).cancelActiveForAgent(a.agentId)).toBe(0);
  const saved = await receipt(a); expect(saved.invalidated?.cause).toBe("user_cancel");
  expect(await heartbeatService(peer).cancelActiveForAgent(a.agentId)).toBe(0);
  expect(await receipt(a)).toEqual(saved);
  holds.get(a.parent.id)!.release(); await drain(); await noRevival(a);
  expect(starts).toEqual([a.parent.id]); expect((await receipt(a)).delivery).toBeNull();
}, 30_000);

it.each(["claim", "wake", "start"] as const)("invalidation commits on the second connection before %s resumes", async boundary => {
  const a = await work(await world()); await pause(a); await retain(a); const child = await queued(a);
  const reached = gate(), proceed = gate();
  const realClaim = recovery.claimQueuedRunWithRecoveryGuard, realStart = recovery.executeHeartbeatWithRecoveryGuard;
  if (boundary !== "start") vi.spyOn(recovery, "claimQueuedRunWithRecoveryGuard").mockImplementation(async (deps, run) => {
    if (boundary === "claim" && run.id === child.id) { reached.release(); await proceed.promise; }
    return realClaim(boundary === "wake" ? { ...deps, recordQueueTransitionEvent: async input => {
      if (run.id === child.id) { reached.release(); await proceed.promise; }
      await deps.recordQueueTransitionEvent(input);
    } } : deps, run);
  });
  else vi.spyOn(recovery, "executeHeartbeatWithRecoveryGuard").mockImplementation(async (connection, run, execute) => {
    if (run.id === child.id) { reached.release(); await proceed.promise; }
    return realStart(connection, run, execute);
  });
  const queue = heartbeatService(db).resumeQueuedRuns(a.agentId);
  await reached.promise;
  const cancel = heartbeatService(peer).cancelRun(boundary === "claim" ? a.parent.id : child.id);
  const outcomes = Promise.allSettled([queue, cancel]);
  try {
    await vi.waitFor(async () => {
      expect((await receipt(a)).invalidated?.cause).toBe("user_cancel");
      expect((await readRun(child.id))!.status).toBe("cancelled");
      expect((await readWake(child.wakeupRequestId!))!.status).toBe("cancelled");
    }, { timeout: 10_000 });
    expect(starts).toEqual([a.parent.id]);
  } finally { proceed.release(); }
  expect((await outcomes).every(r => r.status === "fulfilled")).toBe(true);
  await drain();
  expect((await readWake(child.wakeupRequestId!))!.status).toBe("cancelled");
  expect(await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.heartbeatRunId, child.id), eq(workflowTransitionEvents.eventType, "queue_run_started"),
  ))).toHaveLength(boundary === "claim" ? 0 : 1);
  const saved = [await receipt(a), await readRun(child.id), await readWake(child.wakeupRequestId!)];
  await heartbeatService(peer).cancelRun(child.id);
  expect([await receipt(a), await readRun(child.id), await readWake(child.wakeupRequestId!)]).toEqual(saved);
  await noRevival(a); expect(starts).toEqual([a.parent.id]);
}, 30_000);

it("internal budget admission refusal is not a public user cancellation", async () => {
  const a = await work(await world()); await pause(a); await retain(a); const child = await queued(a);
  await peer.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, a.companyId));
  await heartbeatService(peer).resumeQueuedRuns(a.agentId); await drain();
  expect((await readRun(child.id))!.status).toBe("cancelled");
  expect((await receipt(a)).invalidated).toBeNull(); expect(starts).toEqual([a.parent.id]);
}, 30_000);

it.each(["receipt", "run", "wake"] as const)("a failed %s write rolls back invalidation and exact child state", async fault => {
  const a = await work(await world()); await pause(a); await retain(a); const child = await queued(a);
  const p = await receipt(a), table = fault === "run" ? "heartbeat_runs" : "agent_wakeup_requests";
  const id = fault === "receipt" ? p.id : fault === "run" ? child.id : child.wakeupRequestId!;
  const before = [p, await readRun(child.id), await readWake(child.wakeupRequestId!)];
  const publish = vi.spyOn(live, "publishLiveEvent"), signal = vi.spyOn(process, "kill");
  await db.$client.unsafe(`CREATE FUNCTION c05_invalidation_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.id='${id}' THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER c05_invalidation_failure BEFORE UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION c05_invalidation_failure()`);
  try { await expect(heartbeatService(peer).cancelRun(a.parent.id)).rejects.toThrow(); }
  finally { await db.$client.unsafe(`DROP TRIGGER c05_invalidation_failure ON ${table}; DROP FUNCTION c05_invalidation_failure()`); }
  expect([await receipt(a), await readRun(child.id), await readWake(child.wakeupRequestId!)]).toEqual(before);
  expect(publish).not.toHaveBeenCalled();
  expect(signal.mock.calls.filter(([, value]) => value === "SIGTERM" || value === "SIGKILL")).toEqual([]);
  expect(starts).toEqual([a.parent.id]);
  await heartbeatService(peer).cancelRun(a.parent.id); await noRevival(a);
}, 30_000);

it.each([
  ["company", false], ["agent", false], ["project", false],
  ["company", true], ["agent", true], ["project", true],
] as const)("real %s budget enforcement invalidates delivered=%s, preserving outside work and spend", async (scopeType, delivered) => {
  const w = await world(), a = await work(w);
  const outside = scopeType === "project" ? w : await world(scopeType === "agent" ? w.companyId : undefined);
  const b = await work(outside); await pause(a, b); await retain(a, b);
  const child = delivered ? await queued(a) : null;
  const ordinary = await db.insert(agentWakeupRequests).values({ companyId: a.companyId, agentId: a.agentId,
    source: "on_demand", status: "queued", payload: { issueId: a.issueId, projectId: a.projectId } }).returning();
  await db.insert(costEvents).values({ companyId: a.companyId, agentId: a.agentId, projectId: a.projectId,
    provider: "test", model: "test", costCents: 2, occurredAt: new Date() });
  const costs = await peer.select().from(costEvents).where(eq(costEvents.companyId, a.companyId));
  const scopeId = scopeType === "company" ? a.companyId : scopeType === "agent" ? a.agentId : a.projectId;
  const svc = heartbeatService(peer);
  const budgets = budgetService(peer, { cancelWorkForScope: svc.cancelBudgetScopeWork });
  await budgets.upsertPolicy(a.companyId, { scopeType, scopeId, amount: 1, notifyEnabled: false }, null);
  expect((await receipt(a)).invalidated?.cause).toBe("budget");
  expect((await receipt(b)).invalidated).toBeNull();
  expect((await readWake(ordinary[0].id))!.status).toBe("cancelled");
  if (child) {
    expect((await readRun(child.id))!.status).toBe("cancelled");
    expect((await readWake(child.wakeupRequestId!))!.status).toBe("cancelled");
  } else expect((await receipt(a)).delivery).toBeNull();
  // Raising the real policy resumes its normal scope; it cannot restore the revoked pause intention.
  await budgets.upsertPolicy(a.companyId, { scopeType, scopeId, amount: 100, notifyEnabled: false }, null);
  await heartbeatService(peer).resumeQueuedRuns();
  await vi.waitFor(async () => {
    const p = await receipt(b); expect(p.delivery?.heartbeatRunId).toBeTruthy();
    expect(starts).toContain(p.delivery!.heartbeatRunId!);
  }, { timeout: 10_000 });
  holds.get((await receipt(b)).delivery!.heartbeatRunId!)!.release(); await drain(); await noRevival(a);
  expect(starts.filter(id => id !== a.parent.id && id !== b.parent.id)).toEqual([(await receipt(b)).delivery!.heartbeatRunId]);
  expect(await peer.select().from(costEvents).where(eq(costEvents.companyId, a.companyId))).toEqual(costs);
}, 30_000);
