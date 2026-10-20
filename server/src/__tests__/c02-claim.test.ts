import path from "node:path";
import { rm } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, instanceSettings, issues, qualityPolicyVersions,
  workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { claimHeartbeatWithRecoveryGuard, executeHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { QaCorrectionRootOwnerRequired } from "../services/issue-assignment-wakeup.js";
import { withReplacementFirstDelivery } from "../services/workflow/replacement-first-delivery.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { createCommitSourceHarness, issueNextC02, deliveryInput, deliver,
  correctionRows, deliveryState, waitForDeliveryLocks } from "./helpers/c02-delivery-fixture.js";
import { createClaimFixture, issueFollowingC02 } from "./helpers/c02-claim-race-fixture.js";

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
let fixtures: ReturnType<typeof createClaimFixture>;
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
  fixtures = createClaimFixture(owned, track, roots, releases);
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
type World = Awaited<ReturnType<typeof fixtures.world>>;
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

it.each([false, true])("valid B claims and invokes once with finalization=%s, reusing the last quality use", async enabled => {
  const w = await fixtures.world(true), b = await queued(w), before = await deliveryState(w.c), g = gate(w);
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
  const w = await fixtures.world(), b = await queued(w), c = await issueNextC02(w.c), i = await deliveryInput(c), g = gate(w);
  await deliver(c, i);
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  const id = await g.entered(), rows = await correctionRows(c);
  await noGrant(w, b.id);
  expect(await readRun(w, b.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
  expect(rows.heartbeats.map(r => r.id)).toEqual([id]); expect(calls(id)).toHaveLength(1);
  g.release();
}, 60000);
it.each(["key", "ref"] as const)("does not downgrade a malformed original correction %s to ordinary work", async kind => {
  const w = await fixtures.world(), b = await queued(w), rows = await correctionRows(w.c), wake = rows.wakes[0]!;
  await owned.db.update(agentWakeupRequests).set(kind === "key" ? { idempotencyKey: "qa-correction-wake:wrong" }
    : { payload: { ...wake.payload, qaCorrectionFollowup: {} } }).where(eq(agentWakeupRequests.id, wake.id));
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  await noGrant(w, b.id);
  expect((await readRun(w, b.id)).status).toBe("cancelled");
}, 30000);
it.each(["heartbeat", "pending"] as const)("nested %s preserves B on rollback and drains only after actual outer commit", async kind => {
  const w = await fixtures.world(false, kind === "heartbeat"), target = await fixtures.replacement(), dag = await fixtures.ordinaryDag(w);
  if (kind === "pending") await fixtures.pending(w);
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
  const w = await fixtures.world(kind === "policy"), b = await queued(w), holder = track(owned.connect());
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
  const w = await fixtures.world(), b = await queued(w);
  const tasks = await fixtures.insertGate(w, "workflow_transition_events",
    "NEW.event_type='qa_remediation_applied' AND NEW.payload->>'schemaVersion'='workflow.qa-correction.applied.v1'", async pid => {
      const issuing = finish(issueNextC02(w.c));
      const [issuer] = await fixtures.blockedInsert(w, pid);
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
  const w = await fixtures.world(), b = await queued(w);
  await fixtures.insertGate(w, "effect_intents", "true", async pid => {
    await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
    await fixtures.blockedInsert(w, pid);
    expect((await readRun(w, b.id)).startedAt).toBeInstanceOf(Date);
    if (kind === "C") await issueNextC02(w.c);
    else await heartbeatService(w.c.peer).cancelRun(b.id);
  });
  await drain(); expect(calls(b.id)).toHaveLength(0);
  expect(await readRun(w, b.id)).toMatchObject(kind === "C"
    ? { status: "failed", errorCode: "heartbeat_recovery_blocked" } : { status: "cancelled" });
}, 60000);

it.each(["process_lost_retry", "adapter_failed_retry", "adapter_fallback"])("follows original B through actual %s child with no direct ref", async kind => {
  const w = await fixtures.world(), b = await queued(w), before = await deliveryState(w.c);
  const parent = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
  const child = await fixtures.retry(w, parent, kind);
  const [wake] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!));
  expect(wake!.payload).not.toHaveProperty("qaCorrectionFollowup");
  const claimed = (await claimHeartbeatWithRecoveryGuard(owned.db, child, new Date()))!;
  expect(claimed.status).toBe("running");
  const staleChild = await fixtures.retry(w, claimed, kind);
  await issueNextC02(w.c);
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, staleChild, new Date())).rejects.toThrow();
  await noGrant(w, staleChild.id);
  const after = await deliveryState(w.c);
  expect([after.usage, after.groups, after.receipts]).toEqual([before.usage, before.groups, before.receipts]);
}, 60000);
it("accepts 32 technical ancestors, refuses the 33rd and a real stored cycle without changing claims", async () => {
  const w = await fixtures.world(), b = await queued(w);
  let parent = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
  for (let n = 0; n < 31; n++) parent = (await claimHeartbeatWithRecoveryGuard(owned.db,
    await fixtures.retry(w, parent, "process_lost_retry"), new Date()))!;
  const over = await fixtures.retry(w, parent, "process_lost_retry");
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, over, new Date())).rejects.toThrow();
  await noGrant(w, over.id);
  await owned.db.update(heartbeatRuns).set({ retryOfRunId: over.id }).where(eq(heartbeatRuns.id, over.id));
  const [cycle] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, over.id));
  await expect(claimHeartbeatWithRecoveryGuard(owned.db, cycle!, new Date())).rejects.toThrow();
  await noGrant(w, over.id);
}, 120000);

it.each(["generation", "step"] as const)("rejects stored heartbeat %s mismatch before nested notification and always rolls back", async kind => {
  const w = await fixtures.world(), b = await queued(w), target = await fixtures.replacement();
  const changed = kind === "generation" ? { workflowExecutionGeneration: b.workflowExecutionGeneration! + 1 }
    : { workflowStepRunId: w.c.s.p.producer.stepRunId };
  await owned.db.update(heartbeatRuns).set(changed).where(eq(heartbeatRuns.id, b.id));
  const stored = await readRun(w, b.id), before = await deliveryState(w.c), rollback = Error("identity outer rollback");
  let observed: unknown;
  // C02: a stored nonnull identity must match the original request BEFORE registering a root drain.
  await expect(withReplacementFirstDelivery(owned.db, target, async tx => {
    try { await heartbeatService(track(tx)).resumeQueuedRuns(w.i.agentId); }
    catch (error) { observed = error; }
    throw rollback;
  })).rejects.toBe(rollback);
  expect(observed).toBeInstanceOf(Error);
  expect(observed).toMatchObject({ message: "qa_correction_claim_relation_changed" });
  expect(await readRun(w, b.id)).toEqual(stored);
  await noGrant(w, b.id);
  expect(await deliveryState(w.c)).toEqual(before);
}, 60000);
it.each(["generation", "step"] as const)("execution guard rejects identical supplied and stored %s mismatch without callback", async kind => {
  const w = await fixtures.world(), b = await queued(w);
  const running = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
  const changed = kind === "generation" ? { workflowExecutionGeneration: running.workflowExecutionGeneration! + 1 }
    : { workflowStepRunId: w.c.s.p.producer.stepRunId };
  await owned.db.update(heartbeatRuns).set(changed).where(eq(heartbeatRuns.id, b.id));
  const stored = await readRun(w, b.id), before = await deliveryState(w.c), callback = vi.fn(async () => stopped);
  // Direct exported boundary evidence; this does not claim a malformed queued row reaches the public adapter.
  await expect(executeHeartbeatWithRecoveryGuard(owned.db, stored, callback)).rejects.toMatchObject({
    code: "heartbeat_recovery_blocked", message: "qa_correction_claim_relation_changed",
  });
  expect(callback).not.toHaveBeenCalled(); expect(calls(b.id)).toHaveLength(0);
  expect(await deliveryState(w.c)).toEqual(before);
}, 60000);
it.each(["step", "generation", "both"] as const)("preserves legal null %s identity at the public claim", async kind => {
  const w = await fixtures.world(), b = await queued(w), g = gate(w);
  await owned.db.update(heartbeatRuns).set({ ...(kind !== "generation" ? { workflowStepRunId: null } : {}),
    ...(kind !== "step" ? { workflowExecutionGeneration: null } : {}) }).where(eq(heartbeatRuns.id, b.id));
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  expect(await g.entered()).toBe(b.id); expect(calls(b.id)).toHaveLength(1); g.release();
}, 60000);
it("preserves an owner created after B observation while that new owner remains locked", async () => {
  const w = await fixtures.world(), b = await queued(w);
  const owner = await fixtures.changeOwnerAfterObservation(w, b,
    () => heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId), finish);
  await noGrant(w, b.id);
  expect(await readRun(w, b.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
  const [issue] = await w.c.peer.select().from(issues).where(eq(issues.id, w.i.issueId));
  expect(issue).toMatchObject({ executionRunId: owner.id, checkoutRunId: owner.id });
  expect(calls(owner.id)).toHaveLength(0);
}, 60000);
it("claims only the latest of 33 real corrections without applying the technical ancestor limit to history", async () => {
  const first = await fixtures.world(false, false), history = [first.c];
  for (let n = 1; n <= 32; n++) history.push(await issueFollowingC02(history[history.length - 1]!, n));
  const c = history[history.length - 1]!, w = { c, i: await deliveryInput(c) }, g = gate(w);
  await deliver(c, w.i);
  const latest = await queued(w);
  await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId);
  expect(await g.entered()).toBe(latest.id); expect(calls(latest.id)).toHaveLength(1);
  expect(adapter).toHaveBeenCalledTimes(1);
  const applied = await c.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, c.ref.companyId), eq(workflowTransitionEvents.workflowRunId, c.ref.workflowRunId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_applied")));
  expect(applied).toHaveLength(33);
  const ids = applied.map(row => row.payload.correctionId);
  expect(new Set(ids).size).toBe(33);
  expect(new Set(ids)).toEqual(new Set(history.map(item => item.s.p.correctionId)));
  for (const earlier of history.slice(0, -1)) {
    const rows = await correctionRows(earlier);
    expect(rows.heartbeats).toEqual([]); expect(rows.wakes).toEqual([]);
    expect(adapter.mock.calls.filter(([input]) => input.context.issueId === earlier.followup.target.issueId)).toHaveLength(0);
  }
  const grants = await c.peer.select().from(workflowTransitionEvents).where(and(
    inArray(workflowTransitionEvents.issueId, history.slice(0, -1).map(item => item.followup.target.issueId)),
    sql`(event_type='queue_run_started' OR reason='executor_owner_lease_claimed')`));
  expect(grants).toEqual([]); g.release();
}, 120000);
