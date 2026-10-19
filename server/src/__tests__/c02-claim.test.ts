import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, heartbeatRunEvents, instanceSettings, issues, qualityPolicyVersions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";
import { QaCorrectionRootOwnerRequired } from "../services/issue-assignment-wakeup.js";
import { withReplacementFirstDelivery } from "../services/workflow/replacement-first-delivery.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { activatePlanningMissionForWorkflowRun } from "../services/missions/mission-workflow-lifecycle.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { createCommitSourceHarness, issueC02, issueNextC02, deliveryInput, deliver,
  correctionRows, deliveryState, waitForDeliveryLocks } from "./helpers/c02-delivery-fixture.js";

// C02/C12: issuance, observation, original proof, PG, DAG and public claim remain real.
// Same B queued -> real C issuance -> public resume distinguishes the old and new claim paths.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const stopped = { exitCode: 1, signal: null, timedOut: false, errorCode: "c02_claim_test_stop",
  errorMessage: "isolated claim stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
const used = new Set<Db>(), releases: (() => void)[] = [], roots: string[] = [];
const operations: Promise<unknown>[] = [];
const finish = <T>(operation: Promise<T>) => { operations.push(operation); void operation.catch(() => {}); return operation; };
const track = (db: Db) => { used.add(db); return db; };
const drain = async () => { for (const db of used) await waitForHeartbeatExecutionsToDrain(db); };
const flag = (enabled: boolean) => owned.db.insert(instanceSettings).values({
  singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: enabled },
}).onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: enabled } } });
beforeAll(async () => {
  owned = await createCommitSourceHarness(); track(owned.db);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "claim-storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
}, 120000);
beforeEach(async () => { adapter.mockReset().mockResolvedValue(stopped); await flag(false); });
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  const settled = await Promise.allSettled(operations.splice(0));
  await drain();
  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(r => r.reason), "public operations did not finish");
}, 60000);
afterAll(async () => {
  await drain(); await owned.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 120000);
async function world(quality = false, queued = true) {
  const c = await issueC02(owned, { mode: "content-only", quality }), i = await deliveryInput(c);
  track(c.peer);
  await c.peer.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, c.s.f.verdictWakeId));
  await c.peer.update(agents).set({ status: "active", adapterType: "codex_local",
    adapterConfig: { cwd: owned.root, promptTemplate: "Isolated claim" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, i.agentId));
  if (queued) await deliver(c, i);
  return { c, i };
}
type World = Awaited<ReturnType<typeof world>>;
const readRun = async (w: World, id: string) => (await w.c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const queued = async (w: World) => (await correctionRows(w.c)).heartbeats[0]!;
const calls = (id: string) => adapter.mock.calls.filter(([input]) => input.runId === id);
function gate(w: World) {
  let entered: string | null = null, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  adapter.mockImplementation(async (input: { runId: string; context: { issueId?: string } }) => {
    if (input.context.issueId === w.i.issueId) { entered = input.runId; await held; }
    return stopped;
  });
  return { release, entered: () => vi.waitFor(() => { expect(entered).not.toBeNull(); return entered!; }, { timeout: 10000 }) };
}
async function noGrant(w: World, id: string) {
  expect(await readRun(w, id)).toMatchObject({ startedAt: null, executionToken: null, executorOwnerId: null, executorOwnerLeaseToken: null });
  const events = await w.c.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.heartbeatRunId, id),
    sql`(event_type='queue_run_started' OR reason='executor_owner_lease_claimed')`));
  expect(events).toEqual([]); expect(calls(id)).toHaveLength(0);
}
async function pending(w: World) {
  const { contextSnapshot, ...request } = w.i.request;
  await insertWorkflowWakeRequest(owned.db, { ...request, companyId: w.i.companyId, agentId: w.i.agentId,
    issueId: w.i.issueId, missionId: w.i.missionId, workflowRunId: w.i.workflowRunId,
    workflowStepRunId: w.i.workflowStepRunId, workflowExecutionGeneration: w.i.workflowExecutionGeneration,
    status: "queued", payload: { ...request.payload, issueId: w.i.issueId, _paperclipWakeContext: contextSnapshot } });
}
async function replacement() {
  const s = await seedReplacement(owned.db); roots.push(s.tempRoot);
  const target = (await admitReplacement(owned.db, s.input, s.actor)).run;
  expect(await claimPlainWorkflowStart(owned.db, target.id,
    { activateMission: activatePlanningMissionForWorkflowRun } as never)).toBe("started");
  await withReplacementFirstDelivery(owned.db, target.id, async () => {});
  return target.id;
}
async function ordinaryDag(w: World) {
  const [definition] = await owned.db.insert(workflowDefinitions).values({ companyId: w.i.companyId, name: "Ordinary nested wake",
    stepsJson: [{ id: "ordinary", name: "Ordinary", type: "agent", agentId: w.i.agentId, dependencies: [] }] }).returning();
  const [run] = await owned.db.insert(workflowRuns).values({ companyId: w.i.companyId, missionId: w.i.missionId,
    workflowId: definition!.id, status: "running", triggeredBy: "test" }).returning();
  const [issue] = await owned.db.insert(issues).values({ companyId: w.i.companyId, missionId: w.i.missionId,
    title: "Ordinary nested issue", status: "todo", assigneeAgentId: w.i.agentId,
    originKind: "workflow_execution", originRunId: run!.id }).returning();
  await owned.db.insert(workflowStepRuns).values({ workflowRunId: run!.id, stepId: "ordinary", issueId: issue!.id, status: "pending" });
  return run!.id;
}
async function insertGate<T>(w: World, table: string, condition: string, during: (pid: number) => Promise<T>): Promise<T> {
  const name = "c02_" + randomUUID().replaceAll("-", ""), key = parseInt(name.slice(4, 11), 16);
  const holder = track(owned.connect());
  await holder.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.company_id='${w.i.companyId}'::uuid AND (${condition}) THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
    RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`));
  try {
    return await holder.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
      const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      return during(Number(pid!.pid));
    });
  } finally {
    await holder.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`));
  }
}
const blockedInsert = (w: World, pid: number) => vi.waitFor(async () => {
  const rows = await w.c.peer.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
    AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%insert%'`);
  expect(rows.length).toBeGreaterThan(0); return rows;
}, { timeout: 10000 });

it.each([false, true])("valid B claims and invokes once with finalization=%s, reusing the last quality use", async enabled => {
  const w = await world(true), b = await queued(w), before = await deliveryState(w.c), g = gate(w);
  await flag(enabled);
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  expect(await g.entered()).toBe(b.id);
  expect(await readRun(w, b.id)).toMatchObject({ status: "running", finalizationVersion: enabled ? 1 : 0 });
  expect(calls(b.id)).toHaveLength(1);
  const after = await deliveryState(w.c);
  expect([after.usage, after.groups, after.receipts]).toEqual([before.usage, before.groups, before.receipts]);
  expect(before.usage.reduce((sum, row) => sum + row.executionAttempts, 0)).toBe(1);
  g.release();
}, 60000);
it("rejects actually queued B after real C issuance and starts C in the same public drain", async () => {
  const w = await world(), b = await queued(w), c = await issueNextC02(w.c), i = await deliveryInput(c), g = gate(w);
  await deliver(c, i);
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  const id = await g.entered(), rows = await correctionRows(c);
  await noGrant(w, b.id);
  expect(await readRun(w, b.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
  expect(rows.heartbeats.map(r => r.id)).toEqual([id]); expect(calls(id)).toHaveLength(1);
  g.release();
}, 60000);
it.each(["key", "ref"] as const)("does not downgrade a malformed original correction %s to ordinary work", async kind => {
  const w = await world(), b = await queued(w), rows = await correctionRows(w.c), wake = rows.wakes[0]!;
  await owned.db.update(agentWakeupRequests).set(kind === "key" ? { idempotencyKey: "qa-correction-wake:wrong" }
    : { payload: { ...wake.payload, qaCorrectionFollowup: {} } }).where(eq(agentWakeupRequests.id, wake.id));
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  await noGrant(w, b.id);
  expect((await readRun(w, b.id)).status).toBe("cancelled");
}, 30000);
it.each(["heartbeat", "pending"] as const)("nested %s preserves B on rollback and drains only after actual outer commit", async kind => {
  const w = await world(false, kind === "heartbeat"), target = await replacement(), dag = await ordinaryDag(w);
  if (kind === "pending") await pending(w);
  const b = kind === "heartbeat" ? await queued(w) : null, before = await deliveryState(w.c);
  if (b) {
    await expect(owned.db.transaction(tx => heartbeatService(track(tx as unknown as Db)).resumeQueuedRuns(w.i.agentId)))
      .rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
    expect(await deliveryState(w.c)).toEqual(before);
  }
  for (const rollback of [true, false]) {
    const g = gate(w), work = withReplacementFirstDelivery(owned.db, target, async tx => {
      track(tx);
      if (b) await syncWorkflowRunState(tx, dag);
      else await heartbeatService(tx).resumeQueuedRuns(w.i.agentId);
      await heartbeatService(tx).resumeQueuedRuns(w.i.agentId);
      expect(adapter.mock.calls.filter(([input]) => input.context.issueId === w.i.issueId)).toHaveLength(0);
      if (b) await noGrant(w, b.id);
      expect(await deliveryState(w.c)).toEqual(before);
      if (rollback) throw Error("outer rollback");
    });
    if (rollback) {
      await expect(work).rejects.toThrow("outer rollback");
      expect(await deliveryState(w.c)).toEqual(before); g.release();
    } else {
      await work; const id = await g.entered();
      expect(calls(id)).toHaveLength(1); g.release(); await drain();
    }
  }
}, 60000);
it.each(["cancel", "policy"] as const)("rolls back a claim when %s changes after the real observation", async kind => {
  const w = await world(kind === "policy"), b = await queued(w), holder = track(owned.connect());
  let resumed!: Promise<void>;
  await holder.transaction(async tx => {
    if (kind === "policy") {
      const a = w.c.s.p.authority; if (a.kind !== "quality_current_output") throw Error("quality required");
      await tx.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, a.policyVersionId)).for("update");
    } else await tx.select().from(workflowRuns).where(eq(workflowRuns.id, w.i.workflowRunId)).for("no key update");
    const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    resumed = finish(heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId));
    await waitForDeliveryLocks(w.c.peer, Number(pid!.pid), 1);
    if (kind === "policy") {
      const a = w.c.s.p.authority; if (a.kind !== "quality_current_output") throw Error("quality required");
      await tx.update(qualityPolicyVersions).set({ disabledAt: new Date() }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    } else await tx.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, w.i.workflowRunId));
  });
  await resumed; await noGrant(w, b.id);
}, 60000);
it("rolls back when real C commits after B observation while the claim waits on its run", async () => {
  const w = await world(), b = await queued(w);
  const tasks = await insertGate(w, "workflow_transition_events",
    "NEW.event_type='qa_remediation_applied' AND NEW.payload->>'schemaVersion'='workflow.qa-correction.applied.v1'", async pid => {
      const issuing = finish(issueNextC02(w.c));
      const [issuer] = await blockedInsert(w, pid);
      const resumed = finish(heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId));
      await vi.waitFor(async () => {
        const waiting = await w.c.peer.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND ${Number(issuer!.pid)} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%select%'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 10000 });
      return { issuing, resumed };
    });
  await tasks.issuing; await tasks.resumed; await noGrant(w, b.id);
}, 60000);
it.each(["C", "cancel"] as const)("fresh adapter boundary rejects %s after actual claim and effect intent", async kind => {
  const w = await world(), b = await queued(w);
  await insertGate(w, "effect_intents", "true", async pid => {
    await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
    await blockedInsert(w, pid);
    expect((await readRun(w, b.id)).startedAt).toBeInstanceOf(Date);
    if (kind === "C") await issueNextC02(w.c);
    else await heartbeatService(w.c.peer).cancelRun(b.id);
  });
  await drain(); expect(calls(b.id)).toHaveLength(0);
  expect(await readRun(w, b.id)).toMatchObject(kind === "C"
    ? { status: "failed", errorCode: "heartbeat_recovery_blocked" } : { status: "cancelled" });
}, 60000);

async function retry(w: World, parent: typeof heartbeatRuns.$inferSelect, kind: string) {
  const [agent] = await owned.db.select().from(agents).where(eq(agents.id, w.i.agentId));
  const deps = { db: owned.db, resolveSessionBeforeForWakeup: async () => {
    const sessions = await w.c.peer.execute(sql`SELECT id FROM agent_task_sessions WHERE agent_id=${w.i.agentId}
      UNION ALL SELECT id FROM mission_sessions WHERE agent_id=${w.i.agentId}`);
    expect(sessions).toEqual([]); return null;
  }, appendRunEvent: async (run: typeof heartbeatRuns.$inferSelect, seq: number, event: { eventType: string; payload?: Record<string, unknown> }) => {
    await owned.db.insert(heartbeatRunEvents).values({ companyId: run.companyId,
      runId: run.id, agentId: run.agentId, seq, ...event });
  } };
  return kind === "adapter_fallback"
    ? enqueueAdapterFallbackRun(deps, parent, agent!, new Date(), { fallbackCommand: "isolated", fallbackReason: "test" })
    : enqueueProcessLossRetry(deps, parent, agent!, new Date(),
      { kind: kind === "adapter_failed_retry" ? "adapter_failed_transient" : "process_lost" });
}
it.each(["process_lost_retry", "adapter_failed_retry", "adapter_fallback"])("follows original B through actual %s child with no direct ref", async kind => {
  const w = await world(), b = await queued(w), before = await deliveryState(w.c);
  const parent = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
  const child = await retry(w, parent, kind);
  const [wake] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!));
  expect(wake!.payload).not.toHaveProperty("qaCorrectionFollowup");
  const claimed = (await claimHeartbeatWithRecoveryGuard(owned.db, child, new Date()))!;
  expect(claimed.status).toBe("running");
  const staleChild = await retry(w, claimed, kind);
  await issueNextC02(w.c);
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, staleChild, new Date())).rejects.toThrow();
  await noGrant(w, staleChild.id);
  const after = await deliveryState(w.c);
  expect([after.usage, after.groups, after.receipts]).toEqual([before.usage, before.groups, before.receipts]);
}, 60000);
it("accepts 32 technical ancestors, refuses the 33rd and a real stored cycle without changing claims", async () => {
  const w = await world(), b = await queued(w);
  let parent = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
  for (let n = 0; n < 31; n++) parent = (await claimHeartbeatWithRecoveryGuard(owned.db,
    await retry(w, parent, "process_lost_retry"), new Date()))!;
  const over = await retry(w, parent, "process_lost_retry");
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, over, new Date())).rejects.toThrow();
  await noGrant(w, over.id);
  await owned.db.update(heartbeatRuns).set({ retryOfRunId: over.id }).where(eq(heartbeatRuns.id, over.id));
  const [cycle] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, over.id));
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, cycle!, new Date())).rejects.toThrow();
  await noGrant(w, over.id);
}, 120000);
