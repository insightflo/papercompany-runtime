import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings,
  issues, missions, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Only the external adapter is replaced. Admission, claim, release, DB locks and
// queue discovery use the production services and a private migrated PostgreSQL.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
  runningProcesses: new Map(),
}));
const completed = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let db: Db, peer: Db, root: string;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const agentIds = new Set<string>();
const gates = new Map<string, () => void>();
export const calls: Array<{ runId: string; agentId: string; issueId: unknown }> = [];

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-queued-ownership-");
  db = createDb(temp.connectionString);
  peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-queued-ownership-"));
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({ singletonKey: "default" });
}, 60_000);
afterEach(async () => {
  if (agentIds.size) await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  for (const release of gates.values()) release();
  await drainOwner(); await drainPeer();
  gates.clear(); agentIds.clear(); calls.length = 0; adapter.mockReset();
}, 60_000);
afterAll(async () => {
  await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 60_000);

export const database = () => db;
export const peerDatabase = () => peer;
export const drainOwner = (timeout = 20_000) => waitForHeartbeatExecutionsToDrain(db, timeout);
export const drainPeer = () => waitForHeartbeatExecutionsToDrain(peer, 20_000);
export function finish(runId: string) {
  const release = gates.get(runId);
  if (!release) throw new Error("Adapter has not entered: " + runId);
  release();
}
export async function started(agentId: string, count = 1) {
  await vi.waitFor(() => expect(calls.filter(c => c.agentId === agentId)).toHaveLength(count),
    { timeout: 10_000 });
  return calls.filter(c => c.agentId === agentId)[count - 1]!.runId;
}
export async function readIssue(id: string) {
  return (await peer.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
    .from(issues).where(eq(issues.id, id)))[0]!;
}
export async function readWake(id: string) {
  return (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
}
export async function readRun(id: string) {
  return (await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
}

/** Busy owner -> public issue_assigned admission -> durable queued row with no run. */
export async function queuedWorld(finalization = false) {
  await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: finalization } });
  adapter.mockImplementation(async (ctx: AdapterExecutionContext) => {
    const pending = new Promise<void>(resolve => { gates.set(ctx.runId, resolve); });
    calls.push({ runId: ctx.runId, agentId: ctx.agent.id, issueId: ctx.context.issueId ?? null });
    await pending;
    return completed;
  });
  const companyId = randomUUID(), missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Queued ownership",
    issuePrefix: "O" + companyId.replaceAll("-", "") });
  const [owner, qa] = await db.insert(agents).values(["Owner", "QA"].map(name => ({
    companyId, name, status: "idle", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Private queued ownership fixture" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
  }))).returning();
  agentIds.add(owner!.id); agentIds.add(qa!.id);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: owner!.id,
    title: "Queued ownership", status: "running" });
  const [issue] = await db.insert(issues).values({ companyId, missionId, title: "Ownership handoff",
    assigneeAgentId: owner!.id, status: "todo" }).returning();
  const service = heartbeatService(db), qaService = heartbeatService(peer);
  await service.wakeup(owner!.id, { source: "on_demand", reason: "ownership_owner_busy",
    contextSnapshot: { missionId } });
  const ownerRunId = await started(owner!.id);
  expect(await readRun(ownerRunId)).toMatchObject({ status: "running", issueId: null });
  expect(await service.wakeup(owner!.id, { source: "assignment", reason: "issue_assigned",
    payload: { issueId: issue!.id, missionId, mutation: "issue_assigned" },
    contextSnapshot: { issueId: issue!.id, missionId } })).toBeNull();
  const [request] = await peer.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, owner!.id),
    eq(agentWakeupRequests.issueId, issue!.id), eq(agentWakeupRequests.reason, "issue_assigned"),
  ));
  expect(request).toMatchObject({ status: "queued", runId: null });
  expect(await readIssue(issue!.id)).toMatchObject({ executionRunId: null, checkoutRunId: null });
  return { companyId, missionId, issueId: issue!.id, owner: owner!, qa: qa!, service, qaService,
    ownerRunId, request: request! };
}
export type World = Awaited<ReturnType<typeof queuedWorld>>;

export async function startQa(w: World, reassign: boolean) {
  if (reassign) await db.update(issues).set({ assigneeAgentId: w.qa.id }).where(eq(issues.id, w.issueId));
  // A manual peer execution keeps the assignment current in O2. Initial admission
  // already supports this; O1 instead explicitly transfers the assignment to QA.
  await w.qaService.wakeup(w.qa.id, { source: reassign ? "assignment" : "on_demand",
    reason: reassign ? "issue_assigned" : "ownership_peer_review",
    payload: { issueId: w.issueId, missionId: w.missionId },
    contextSnapshot: { issueId: w.issueId, missionId: w.missionId } });
  const qaRunId = await started(w.qa.id);
  expect(await readRun(qaRunId)).toMatchObject({ status: "running", issueId: w.issueId });
  expect(await readIssue(w.issueId)).toMatchObject({ executionRunId: qaRunId, checkoutRunId: qaRunId });
  return qaRunId;
}

/** Diagnostic output only. Host must retain baseline/candidate logs against their exact heads. */
export async function evidence(phase: string, w: World) {
  const issue = await readIssue(w.issueId);
  const runs = await peer.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, status: heartbeatRuns.status, wakeupRequestId: heartbeatRuns.wakeupRequestId,
    finalizationVersion: heartbeatRuns.finalizationVersion, settledAt: heartbeatRuns.settledAt })
    .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, w.companyId));
  const wakes = await peer.select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId,
    issueId: agentWakeupRequests.issueId, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
    reason: agentWakeupRequests.reason, error: agentWakeupRequests.error, finishedAt: agentWakeupRequests.finishedAt })
    .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, w.companyId));
  console.info("queued_ownership_evidence", JSON.stringify({ version: 1, phase, companyId: w.companyId,
    missionId: w.missionId, issue, runs, wakes, adapterCalls: [...calls] }));
  return { issue, runs, wakes };
}
