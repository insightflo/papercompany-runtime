import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { agentService } from "../services/agents.js";
import { heartbeatService, DEFERRED_WAKE_CONTEXT_KEY } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import * as delivery from "../services/heartbeat-pause-delivery.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const completed = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let db: Db, peer: Db, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, root: string;
const agentIds = new Set<string>(), releases = new Set<() => void>();
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-queue-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-c05-queue-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({ singletonKey: "default" });
}, 60_000);
async function drain() {
  await waitForHeartbeatExecutionsToDrain(db); await waitForHeartbeatExecutionsToDrain(peer);
}
afterEach(async () => {
  if (agentIds.size) await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  vi.restoreAllMocks();
  for (const release of releases) release();
  await drain();
  agentIds.clear(); releases.clear(); adapter.mockReset();
}, 60_000);
afterAll(async () => {
  await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 60_000);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.add(release); return { promise, release };
}
async function world(enabled = false, maxConcurrentRuns = 1) {
  await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: enabled } });
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05 queue", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Isolated queue test" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns } } });
  agentIds.add(agentId); return { companyId, agentId, service: heartbeatService(db) };
}
const runs = (agentId: string) => peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
async function receipts(agentId: string) {
  return (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
    .filter(r => r.source === "internal_agent_pause_v1").map(readPauseControl)
    .filter((p): p is PauseReceipt => p.kind === "receipt");
}
async function running(enabled = false, max = 1) {
  const w = await world(enabled, max), original = gate(), successor = gate(), starts: string[] = [];
  adapter.mockImplementation(async (ctx: AdapterExecutionContext) => {
    starts.push(ctx.runId); await (starts.length === 1 ? original.promise : successor.promise); return completed;
  });
  await w.service.wakeup(w.agentId, { source: "on_demand", triggerDetail: "manual", reason: "c05_queue" });
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 10_000 });
  const [parent] = await runs(w.agentId);
  expect(parent.id).toBe(starts[0]);
  return { ...w, parent, starts, original, successor };
}
type World = Awaited<ReturnType<typeof running>>;
async function resume(w: World) {
  await w.service.resumeAgent(w.agentId); await w.service.resumeQueuedRuns(w.agentId);
}
async function startedChild(w: World) {
  await vi.waitFor(async () => {
    expect(w.starts).toHaveLength(2);
    expect((await receipts(w.agentId))[0].delivery?.heartbeatRunId).toBe(w.starts[1]);
  }, { timeout: 10_000 });
  const children = (await runs(w.agentId)).filter(h => h.retryOfRunId === w.parent.id);
  expect(children).toHaveLength(1);
  const child = children[0], [p] = await receipts(w.agentId);
  expect(child).toMatchObject({ id: w.starts[1], status: "running", processLossRetryCount: w.parent.processLossRetryCount });
  expect(p.delivery).toEqual({ heartbeatRunId: child.id, wakeupRequestId: child.wakeupRequestId });
  const [wake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!));
  expect(wake).toMatchObject({ runId: child.id, status: "claimed", requestKind: "agent_pause_resume" });
  expect(await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.heartbeatRunId, child.id), eq(workflowTransitionEvents.eventType, "queue_run_started"),
  ))).toHaveLength(1);
  return child;
}
// Leave a real finally-written stop receipt behind a failed queue callback, never inject proof/approval.
async function retained(max = 1) {
  const w = await running(false, max);
  await w.service.pauseAgent(w.agentId); await resume(w);
  const fail = vi.spyOn(delivery, "deliverPauseResume").mockRejectedValue(new Error("queue callback unavailable"));
  try { w.original.release(); await drain(); } finally { fail.mockRestore(); }
  const [p] = await receipts(w.agentId);
  expect(p.stopped?.heartbeatRunId).toBe(w.parent.id); expect(p.resumeScopeId).toBe(p.ownerScopeId);
  expect(p.delivery).toBeNull(); expect(await runs(w.agentId)).toHaveLength(1);
  return w;
}
async function ordinary(w: World) {
  // Only the independent ordinary queue fixture is inserted; C05 control/proof writers are always real.
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: w.companyId, agentId: w.agentId,
    source: "on_demand", triggerDetail: "manual", requestKind: "ordinary", reason: "ordinary", status: "queued",
    payload: { [DEFERRED_WAKE_CONTEXT_KEY]: { wakeReason: "ordinary" } } }).returning();
  return wake;
}

// C05 oracle: c05-minimum-plan-adopted.md:46-52,73-95,107-117 and C05.method.
// Same public pause -> ONE resume: pending actual adapter => zero children; its real finally => one start.
// Gates observe adapter completion, not OS-child termination; the fixed real-child probe remains separate.
it.each([false, true])("one resume is delivered by the existing finally, finalization=%s", async enabled => {
  const w = await running(enabled);
  await w.service.pauseAgent(w.agentId); await resume(w);
  const [pending] = await receipts(w.agentId);
  expect(pending.resumeScopeId).toBe(pending.ownerScopeId);
  expect(pending.stopped).toBeNull(); expect(pending.delivery).toBeNull();
  await heartbeatService(peer).resumeQueuedRuns();
  expect(await runs(w.agentId)).toHaveLength(1); expect(w.starts).toEqual([w.parent.id]);
  w.original.release();
  const child = await startedChild(w), [saved] = await receipts(w.agentId);
  expect(saved.stopped).toMatchObject({ heartbeatRunId: w.parent.id,
    method: enabled ? "finalization_quiescence" : "legacy_execution_cleanup" });
  expect((await runs(w.agentId)).find(h => h.id === w.parent.id)!.settledAt === null).toBe(!enabled);
  await w.service.resumeQueuedRuns(w.agentId); await heartbeatService(peer).resumeQueuedRuns();
  expect(w.starts).toEqual([w.parent.id, child.id]); expect(await receipts(w.agentId)).toEqual([saved]);
  w.successor.release(); await drain();
  await heartbeatService(peer).resumeQueuedRuns(); await drain();
  expect(w.starts).toEqual([w.parent.id, child.id]); expect(await runs(w.agentId)).toHaveLength(2);
}, 30_000);

it("a fresh service discovers only-skipped control intent and reuses the same delivered child", async () => {
  const w = await retained(), recovered = heartbeatService(peer);
  expect(await peer.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.agentId, w.agentId), eq(heartbeatRuns.status, "queued"),
  ))).toHaveLength(0);
  expect(await peer.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.agentId, w.agentId), eq(agentWakeupRequests.status, "queued"), isNull(agentWakeupRequests.runId),
  ))).toHaveLength(0);
  const [pending] = await receipts(w.agentId);
  await recovered.resumeQueuedRuns();
  const child = await startedChild(w);
  expect((await delivery.deliverPauseResume(db, pending.id))!.id).toBe(child.id);
  await recovered.resumeQueuedRuns(); await w.service.resumeQueuedRuns(w.agentId);
  expect(w.starts).toEqual([w.parent.id, child.id]);
  w.successor.release(); await drain();
  await heartbeatService(db).resumeQueuedRuns(); await drain();
  expect(w.starts).toEqual([w.parent.id, child.id]); expect(await runs(w.agentId)).toHaveLength(2);
}, 30_000);

it.each(["unapproved", "old_scope", "invalidated"] as const)("queue discovery never authorizes %s intent", async fault => {
  let w: World;
  if (fault === "unapproved") {
    w = await running(); await w.service.pauseAgent(w.agentId);
    w.original.release(); await drain();
    // Ordinary runnable state alone is NOT an explicit approval of the C05 scope.
    await agentService(db).resume(w.agentId);
  } else {
    w = await retained();
    if (fault === "old_scope") {
      await w.service.pauseAgent(w.agentId); await agentService(db).resume(w.agentId);
    } else await w.service.terminateAgent(w.agentId);
  }
  const [p] = await receipts(w.agentId);
  expect(p.stopped?.heartbeatRunId).toBe(w.parent.id);
  if (fault === "unapproved") expect(p.resumeScopeId).toBeNull();
  if (fault === "old_scope") expect(p.resumeScopeId).not.toBe(p.ownerScopeId);
  if (fault === "invalidated") expect(p.invalidated?.cause).toBe("terminate");
  await expect(delivery.deliverPauseResume(peer, p.id)).rejects.toThrow();
  await heartbeatService(peer).resumeQueuedRuns(); await w.service.resumeQueuedRuns(w.agentId);
  expect(await runs(w.agentId)).toHaveLength(1); expect(w.starts).toEqual([w.parent.id]);
  expect(await receipts(w.agentId)).toEqual([p]);
}, 30_000);

it("writer rechecks permission after discovery without blocking an independent ordinary request", async () => {
  const w = await retained(2), wake = await ordinary(w), real = delivery.deliverPauseResume;
  let checked = false;
  const changed = vi.spyOn(delivery, "deliverPauseResume").mockImplementationOnce(async (connection, receiptId) => {
    await peer.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, w.agentId));
    checked = true; return real(connection, receiptId);
  });
  try { await w.service.resumeQueuedRuns(w.agentId); } finally { changed.mockRestore(); }
  expect(checked).toBe(true);
  await vi.waitFor(() => expect(w.starts).toHaveLength(2), { timeout: 10_000 });
  const all = await runs(w.agentId), ordinaryRun = all.find(h => h.wakeupRequestId === wake.id)!;
  expect(ordinaryRun.id).toBe(w.starts[1]); expect(all.filter(h => h.retryOfRunId === w.parent.id)).toHaveLength(0);
  expect((await receipts(w.agentId))[0].delivery).toBeNull();
  w.successor.release(); await drain(); await heartbeatService(peer).resumeQueuedRuns(); await drain();
  expect(w.starts).toEqual([w.parent.id, ordinaryRun.id]); expect(await runs(w.agentId)).toHaveLength(2);
}, 30_000);

it("a nested resume cannot deliver or start before its owning transaction commits", async () => {
  const w = await retained();
  await db.transaction(async tx => {
    await heartbeatService(tx as unknown as Db).resumeQueuedRuns(w.agentId);
    expect(await runs(w.agentId)).toHaveLength(1); expect((await receipts(w.agentId))[0].delivery).toBeNull();
  });
  expect(w.starts).toEqual([w.parent.id]);
  await heartbeatService(peer).resumeQueuedRuns();
  const child = await startedChild(w);
  w.successor.release(); await drain();
  expect(w.starts).toEqual([w.parent.id, child.id]);
}, 30_000);
