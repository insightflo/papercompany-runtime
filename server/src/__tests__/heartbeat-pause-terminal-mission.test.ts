import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings,
  missions, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { heartbeatService } from "../services/heartbeat.js";
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
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-pause-terminal-mission-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-pause-terminal-mission-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({
    singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: false },
  });
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
const runs = (agentId: string) => peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
const missionStatus = (id: string) => peer.select({ status: missions.status }).from(missions).where(eq(missions.id, id));
async function receipts(agentId: string) {
  return (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
    .filter(r => r.source === "internal_agent_pause_v1").map(readPauseControl)
    .filter((p): p is PauseReceipt => p.kind === "receipt");
}

/** A real stop receipt for a mission-bound run, left undelivered exactly like production's ed7f6080. */
async function retained() {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Terminal mission", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Terminal mission test" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
  agentIds.add(agentId);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "m", status: "active" });
  const original = gate(), successor = gate(), starts: string[] = [];
  adapter.mockImplementation(async (ctx: AdapterExecutionContext) => {
    starts.push(ctx.runId); await (starts.length === 1 ? original.promise : successor.promise); return completed;
  });
  const service = heartbeatService(db);
  await service.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "terminal_mission",
    contextSnapshot: { missionId } });
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 10_000 });
  const [parent] = await runs(agentId);
  expect(parent.id).toBe(starts[0]);
  await service.pauseAgent(agentId);
  await service.resumeAgent(agentId); await service.resumeQueuedRuns(agentId);
  // Keep the real receipt stopped but undelivered; the failing mock is never part of the contract.
  const fail = vi.spyOn(delivery, "deliverPauseResume").mockRejectedValue(new Error("queue callback unavailable"));
  try { original.release(); await drain(); } finally { fail.mockRestore(); }
  const [p] = await receipts(agentId);
  expect(p.stopped?.heartbeatRunId).toBe(parent.id);
  expect(p.identity.missionId).toBe(missionId);
  expect(p.resumeScopeId).toBe(p.ownerScopeId);
  expect(p.delivery).toBeNull(); expect(p.invalidated).toBeNull();
  return { companyId, agentId, missionId, parent, starts, successor, service, receipt: p };
}
type World = Awaited<ReturnType<typeof retained>>;

// Requirement: a terminal mission can never accept the resume, so the receipt retires once —
// it must stop repeating the same admission refusal every sweep. Live missions keep the
// ordinary pause->resume path untouched.
it.each(["completed", "cancelled"] as const)("terminal mission %s retires the receipt permanently", async status => {
  const w = await retained();
  await db.update(missions).set({ status }).where(eq(missions.id, w.missionId));
  await heartbeatService(peer).resumeQueuedRuns();
  const [saved] = await receipts(w.agentId);
  expect(saved.invalidated?.cause).toBe("mission_terminal");
  expect(saved.delivery).toBeNull();
  expect(await delivery.selectPauseResumeCandidates(peer, w.agentId)).toHaveLength(0);
  await heartbeatService(peer).resumeQueuedRuns(); // a later sweep neither retries nor rewrites
  expect(await receipts(w.agentId)).toEqual([saved]);
  expect(w.starts).toEqual([w.parent.id]);
  expect(await runs(w.agentId)).toHaveLength(1);
  expect((await missionStatus(w.missionId))[0]?.status).toBe(status);
}, 30_000);

it("a paused mission is not terminal: the receipt keeps waiting and still delivers after resume", async () => {
  const w = await retained();
  await db.update(missions).set({ status: "paused" }).where(eq(missions.id, w.missionId));
  await heartbeatService(peer).resumeQueuedRuns();
  const [blocked] = await receipts(w.agentId);
  expect(blocked.invalidated).toBeNull(); expect(blocked.delivery).toBeNull();
  expect(await delivery.selectPauseResumeCandidates(peer, w.agentId)).toHaveLength(1);
  expect(w.starts).toEqual([w.parent.id]);
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, w.missionId));
  await heartbeatService(peer).resumeQueuedRuns();
  await vi.waitFor(async () => {
    expect(w.starts).toHaveLength(2);
    expect((await receipts(w.agentId))[0].delivery?.heartbeatRunId).toBe(w.starts[1]);
  }, { timeout: 10_000 });
  const [delivered] = await receipts(w.agentId);
  expect(delivered.invalidated).toBeNull();
  w.successor.release(); await drain();
  expect(await runs(w.agentId)).toHaveLength(2);
}, 30_000);
