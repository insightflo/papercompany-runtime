import path from "node:path";
import { rm } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companySecrets, heartbeatRuns, issues, missions, missionSessions, workflowRuns, type Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import * as root from "../services/workflow/control-flow/qa-correction-delivery-root.js";
import * as followup from "../services/workflow/control-flow/qa-correction-followup.js";
import { QaCorrectionRootOwnerRequired } from "../services/issue-assignment-wakeup.js";
import { withReplacementFirstDelivery } from "../services/workflow/replacement-first-delivery.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { activatePlanningMissionForWorkflowRun } from "../services/missions/mission-workflow-lifecycle.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { createCommitSourceHarness, issueC02, issueNextC02, deliveryInput, deliveryState,
  correctionRows, waitForDeliveryLocks } from "./helpers/c02-delivery-fixture.js";

// C02/C12 expectations: one issued request, one persisted link/receipt, no replay execution.
// Only the external adapter is replaced. Issuance, proof, transactions, claims and drains are real.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const stopped = { exitCode: 1, signal: null, timedOut: false, errorMessage: "isolated public delivery stop",
  errorCode: "c02_test_stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] };
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
const used = new Set<Db>(), extraRoots: string[] = [];
const rootCalls = vi.spyOn(root, "withCorrectionDeliveryRoot");
const observations = vi.spyOn(followup, "observeQaCorrectionFollowup");
const track = (db: Db) => { used.add(db); return db; };
const drain = async () => { for (const db of used) await waitForHeartbeatExecutionsToDrain(db); };
beforeAll(async () => {
  owned = await createCommitSourceHarness();
  track(owned.db);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "public-storage"));
}, 120000);
beforeEach(() => { adapter.mockReset().mockResolvedValue(stopped); rootCalls.mockClear(); observations.mockClear(); });
afterEach(drain, 60000);
afterAll(async () => {
  await drain();
  await owned.close();
  for (const dir of extraRoots) await rm(dir, { recursive: true, force: true });
  rootCalls.mockRestore();
  observations.mockRestore();
  vi.unstubAllEnvs();
}, 120000);
type Options = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;
function options(i: root.CorrectionDeliveryInput): Options {
  const r = i.request;
  return { idempotencyKey: r.idempotencyKey, source: r.source as Options["source"],
    triggerDetail: r.triggerDetail, reason: r.reason, payload: r.payload, contextSnapshot: r.contextSnapshot,
    requestedByActorId: r.requestedByActorId, requestedByActorType: r.requestedByActorType as Options["requestedByActorType"] };
}
async function world(quality = true) {
  const c = await issueC02(owned, { mode: "content-only", quality });
  await c.peer.update(agentWakeupRequests).set({ status: "completed" })
    .where(eq(agentWakeupRequests.id, c.s.f.verdictWakeId));
  const i = await deliveryInput(c);
  track(c.peer);
  await c.peer.update(agents).set({ status: "active", adapterType: "codex_local",
    adapterConfig: { cwd: owned.root, promptTemplate: "Isolated public callback" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, i.agentId));
  return { c, i, opts: options(i) };
}
type World = Awaited<ReturnType<typeof world>>;
const wake = (w: World, db = owned.db, opts = w.opts) => heartbeatService(track(db)).wakeup(w.i.agentId, opts);
function gate() {
  let enter!: (runId: string) => void, release!: () => void;
  const entered = new Promise<string>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  adapter.mockImplementation(async ({ runId }) => { enter(runId); await held; return stopped; });
  return { release, entered: () => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("adapter did not enter")), 5000);
    void entered.then(runId => { clearTimeout(timer); resolve(runId); });
  }) };
}
async function pending(w: World, deferred = false) {
  const { i } = w, { contextSnapshot, ...r } = i.request;
  const [row] = await insertWorkflowWakeRequest(owned.db, {
    companyId: i.companyId, agentId: i.agentId, issueId: i.issueId, missionId: i.missionId,
    workflowRunId: i.workflowRunId, workflowStepRunId: i.workflowStepRunId,
    workflowExecutionGeneration: i.workflowExecutionGeneration, ...r,
    reason: deferred ? "issue_execution_deferred" : r.reason, status: deferred ? "deferred_issue_execution" : "queued",
    payload: { ...r.payload, issueId: i.issueId, _paperclipWakeContext: contextSnapshot },
  });
  return row!;
}
async function owner(w: World) {
  const [agent] = await owned.db.insert(agents).values({ companyId: w.i.companyId, name: "Separate cancelled owner", status: "paused" }).returning();
  const [run] = await owned.db.insert(heartbeatRuns).values({ companyId: w.i.companyId, agentId: agent!.id,
    issueId: w.i.issueId, status: "running", contextSnapshot: { issueId: w.i.issueId } }).returning();
  await owned.db.update(issues).set({ executionRunId: run!.id, executionLockedAt: new Date() }).where(eq(issues.id, w.i.issueId));
  return run!;
}
async function state(w: World) {
  return { delivery: await deliveryState(w.c),
    sessions: await w.c.peer.select().from(missionSessions).where(eq(missionSessions.companyId, w.i.companyId)).orderBy(missionSessions.id),
    secrets: await w.c.peer.select().from(companySecrets).where(eq(companySecrets.companyId, w.i.companyId)).orderBy(companySecrets.id) };
}
async function one(w: World) {
  const rows = await correctionRows(w.c);
  expect([rows.wakes.length, rows.heartbeats.length, rows.receipts.length]).toEqual([1, 1, 1]);
  expect(rows.wakes[0]!.runId).toBe(rows.heartbeats[0]!.id);
  return rows;
}
it.each(["initial", "queued", "deferred"] as const)("%s public writer crosses the real root lock chain once", async mode => {
  const w = await world(), g = gate(), peer = track(owned.connect()), holder = track(owned.connect());
  let busy: Awaited<ReturnType<typeof owner>> | undefined, invalidIds: string[] = [], ordinaryId: string | undefined;
  if (mode === "queued") await pending(w);
  if (mode === "deferred") {
    busy = await owner(w);
    const [invalid] = await owned.db.insert(agents).values({ companyId: w.i.companyId, name: "Not invokable", status: "paused" }).returning();
    const bad = await owned.db.insert(agentWakeupRequests).values(Array.from({ length: 49 }, (_, n) => ({
      companyId: w.i.companyId, agentId: invalid!.id, source: "automation", status: "deferred_issue_execution",
      payload: { issueId: w.i.issueId }, requestedAt: new Date(Date.now() - 10000 + n),
    }))).returning({ id: agentWakeupRequests.id });
    invalidIds = bad.map(row => row.id);
    await pending(w, true);
    const [ordinary] = await owned.db.insert(agentWakeupRequests).values({ companyId: w.i.companyId, agentId: w.i.agentId,
      source: "automation", status: "deferred_issue_execution", requestedAt: new Date(Date.now() + 10000),
      payload: { issueId: w.i.issueId, _paperclipWakeContext: { issueId: w.i.issueId } } }).returning();
    ordinaryId = ordinary!.id;
  }
  let first!: Promise<unknown>, replay!: Promise<unknown>;
  try {
    await holder.transaction(async tx => {
      await tx.select().from(workflowRuns).where(eq(workflowRuns.id, w.i.workflowRunId)).for("no key update");
      const [pid] = await tx.execute(sql.raw("SELECT pg_backend_pid() AS pid"));
      first = mode === "initial" ? wake(w) : mode === "queued"
        ? heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId) : heartbeatService(owned.db).cancelRun(busy!.id);
      void first.catch(() => {});
      await waitForDeliveryLocks(w.c.peer, Number(pid!.pid), 1);
      replay = wake(w, peer);
      void replay.catch(() => {});
      expect(new Set(await waitForDeliveryLocks(w.c.peer, Number(pid!.pid), 2)).size).toBe(2);
    });
    await first;
    await replay;
    await g.entered();
    const rows = await one(w), count = adapter.mock.calls.length;
    expect(count).toBe(1);
    expect((await wake(w, peer))!.id).toBe(rows.heartbeats[0]!.id);
    expect(adapter).toHaveBeenCalledTimes(count);
    expect(rootCalls.mock.calls.filter(([, i]) => i.mode === mode).length).toBeGreaterThan(0);
    expect(rootCalls.mock.calls.every(call => call[3]?.transactionProfile === "public_callback")).toBe(true);
    if (ordinaryId) {
      const failed = await w.c.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, w.i.companyId), eq(agentWakeupRequests.status, "failed")));
      expect(failed.map(row => row.id).sort()).toEqual(invalidIds.sort());
      expect((await w.c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ordinaryId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
    }
  } finally { g.release(); await Promise.all([first, replay]); await drain(); }
  // Completion means the real execution and postprocess ended, not a successful QA verdict.
  const rows = await one(w), before = await state(w), count = adapter.mock.calls.length;
  expect(rows.heartbeats[0]!.finishedAt).toBeInstanceOf(Date);
  expect((await wake(w, peer))!.id).toBe(rows.heartbeats[0]!.id);
  expect(await state(w)).toEqual(before);
  expect(adapter).toHaveBeenCalledTimes(count);
}, 60000);
it.each(["paused", "deferred"] as const)("two %s public calls retain the same pending and promote it once", async mode => {
  const w = await world(), g = gate(), busy = mode === "deferred" ? await owner(w) : null;
  if (!busy) await owned.db.update(agents).set({ status: "paused" }).where(eq(agents.id, w.i.agentId));
  try {
    expect(await wake(w)).toBeNull();
    const before = await correctionRows(w.c);
    expect(await wake(w)).toBeNull();
    expect(await correctionRows(w.c)).toEqual(before);
    expect([before.wakes.length, before.heartbeats.length, before.receipts.length]).toEqual([1, 0, 0]);
    await owned.db.update(agents).set({ status: "active" }).where(eq(agents.id, w.i.agentId));
    if (busy) await heartbeatService(owned.db).cancelRun(busy.id);
    else expect(await heartbeatService(owned.db).resumeQueuedRuns(w.i.agentId)).toBeUndefined();
    await g.entered();
    const delivered = await one(w);
    expect(delivered.wakes[0]!.id).toBe(before.wakes[0]!.id);
    expect((await wake(w))!.id).toBe(delivered.heartbeats[0]!.id);
    expect(adapter).toHaveBeenCalledTimes(1);
  } finally { g.release(); await drain(); }
}, 30000);
it("rejects ref/key/source/actor/payload changes without peer-visible writes", async () => {
  const w = await world();
  await owned.db.update(agents).set({ status: "paused" }).where(eq(agents.id, w.i.agentId));
  await wake(w);
  const before = await state(w);
  for (const change of [
    { idempotencyKey: "qa-correction-wake:wrong" }, { payload: { ...w.opts.payload, qaCorrectionFollowup: {} } },
    { source: "on_demand" as const }, { requestedByActorId: "other" },
    { contextSnapshot: { ...w.opts.contextSnapshot, missionId: w.i.issueId } },
    { payload: { ...w.opts.payload, callerField: { retain: [2, 1] } } },
  ]) {
    await expect(wake(w, owned.db, { ...w.opts, ...change })).rejects.toThrow();
    expect(await state(w)).toEqual(before);
  }
  expect(adapter).not.toHaveBeenCalled();
}, 30000);
it("returns delivered B after actual C issuance and terminal/paused/budget changes; rejects undelivered stale B", async () => {
  const w = await world(false), run = await wake(w);
  await drain();
  await issueNextC02(w.c);
  await owned.db.update(missions).set({ status: "completed" }).where(eq(missions.id, w.i.missionId));
  await owned.db.update(agents).set({ status: "paused" }).where(eq(agents.id, w.i.agentId));
  await owned.db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, w.i.companyId));
  const before = await state(w), count = adapter.mock.calls.length;
  expect((await wake(w))!.id).toBe(run!.id);
  expect(await state(w)).toEqual(before);
  expect(adapter).toHaveBeenCalledTimes(count);
  const stale = await world(false);
  await issueNextC02(stale.c);
  const old = await deliveryState(stale.c);
  await expect(wake(stale)).rejects.toThrow();
  expect(await deliveryState(stale.c)).toEqual(old);
}, 60000);
it.each(["active", "mention"] as const)("%s merge keeps both directions isolated and ordinary merging intact", async route => {
  const w = await world(), g = gate(), reason = route === "mention" ? "issue_comment_mentioned" : "ordinary";
  const normal: Options = { source: "automation", reason, idempotencyKey: `workflow-step-retry:${w.i.workflowStepRunId}:1`,
    contextSnapshot: { ...w.i.request.contextSnapshot, wakeReason: reason } };
  try {
    const original = await wake(w, owned.db, normal);
    expect(await g.entered()).toBe(original!.id);
    const control = await wake(w, owned.db, { ...normal, contextSnapshot: { ...normal.contextSnapshot, ordinaryProbe: true } });
    expect(control!.id).toBe(original!.id);
    const snapshot = await w.c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id));
    expect(await wake(w)).toBeNull();
    expect(await w.c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id))).toEqual(snapshot);
    expect((await correctionRows(w.c)).receipts).toHaveLength(0);
  } finally { g.release(); await drain(); }
  const reverse = await world(), held = gate();
  try {
    // The older ordinary task-only run must survive a newer correction candidate in mention .find().
    const older = route === "mention" ? await heartbeatService(owned.db).wakeup(reverse.i.agentId,
      { source: "automation", contextSnapshot: { taskKey: reverse.i.issueId } }) : null;
    const corrected = await wake(reverse);
    expect(await held.entered()).toBe(older?.id ?? corrected!.id);
    const before = await one(reverse);
    if (older) expect(before.heartbeats[0]!.status).toBe("queued");
    const generic = { ...normal, idempotencyKey: `workflow-step-retry:${reverse.i.workflowStepRunId}:1`,
      contextSnapshot: { ...reverse.i.request.contextSnapshot, wakeReason: reason } };
    const first = await wake(reverse, owned.db, generic);
    expect(first?.id).not.toBe(corrected!.id);
    if (older) expect(first!.id).toBe(older.id);
    const ordinary = await wake(reverse, owned.db, { ...generic, contextSnapshot: { ...generic.contextSnapshot, ordinaryProbe: true } });
    expect(ordinary?.id ?? null).toBe(first?.id ?? null);
    expect((await correctionRows(reverse.c)).wakes).toEqual(before.wakes);
    expect((await correctionRows(reverse.c)).heartbeats).toEqual(before.heartbeats);
  } finally { held.release(); await drain(); }
}, 60000);
it("nested public pending validates DB only, rolls back failures and drains the exact wake after the outer commit", async () => {
  const w = await world(), row = await pending(w), s = await seedReplacement(owned.db);
  extraRoots.push(s.tempRoot);
  const target = (await admitReplacement(owned.db, s.input, s.actor)).run;
  expect(await claimPlainWorkflowStart(owned.db, target.id, { activateMission: activatePlanningMissionForWorkflowRun } as never)).toBe("started");
  const before = await state(w);
  await expect(owned.db.transaction(tx => wake(w, track(tx as unknown as Db)))).rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
  await expect(owned.db.transaction(tx => heartbeatService(track(tx as unknown as Db)).resumeQueuedRuns(w.i.agentId)))
    .rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
  const missing = await world(), missingState = await state(missing);
  await expect(withReplacementFirstDelivery(owned.db, target.id, tx => wake(missing, track(tx))))
    .rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
  expect(await state(missing)).toEqual(missingState);
  for (const fault of ["rollback", "ref", "key", "proof", "context", "source", "actor", "payload"] as const) {
    const io = observations.mock.calls.length, calls = adapter.mock.calls.length;
    await expect(withReplacementFirstDelivery(owned.db, target.id, async tx => {
      const changed = structuredClone(w.opts), payload = { ...row.payload };
      if (fault === "ref") changed.payload = { ...changed.payload, qaCorrectionFollowup: {} };
      if (fault === "key") changed.idempotencyKey = "qa-correction-wake:wrong";
      if (fault === "source") changed.source = "on_demand";
      if (fault === "actor") changed.requestedByActorId = "other";
      if (fault === "payload") changed.payload = { ...changed.payload, extra: true };
      if (fault === "proof") payload.__paperclipWorkflowProducerAttempt = {};
      if (fault === "context") payload._paperclipWakeContext = {};
      if (fault === "proof" || fault === "context") await tx.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, row.id));
      const result = await wake(w, track(tx), changed);
      expect(result).toBeNull();
      throw new Error(fault === "rollback" ? "rollback sentinel" : "unexpected nested acceptance");
    })).rejects.toThrow(fault === "rollback" ? "rollback sentinel" : /qa_correction_delivery|workproduct_producer_attempt_unproven/);
    expect(await state(w)).toEqual(before);
    expect(observations).toHaveBeenCalledTimes(io);
    expect(adapter).toHaveBeenCalledTimes(calls);
  }
  const g = gate(), io = observations.mock.calls.length;
  try {
    await withReplacementFirstDelivery(owned.db, target.id, async tx => {
      expect(await wake(w, track(tx))).toBeNull();
      expect(await heartbeatService(track(tx)).resumeQueuedRuns(w.i.agentId)).toBeUndefined();
      expect(await state(w)).toEqual(before);
      expect(adapter).not.toHaveBeenCalled();
      expect(observations).toHaveBeenCalledTimes(io);
    });
    await g.entered();
    expect((await one(w)).wakes[0]!.id).toBe(row.id);
    expect(adapter).toHaveBeenCalledTimes(1);
  } finally { g.release(); await drain(); }
}, 60000);
