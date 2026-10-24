import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, qualityActions, qualityActionGroups, qualityPolicyUsage,
  workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createCommitSourceHarness } from "./helpers/c02-fixture.js";
import { createClaimFixture } from "./helpers/c02-claim-race-fixture.js";
import { correctionRows, deliveryWriter } from "./helpers/c02-delivery-fixture.js";
import { qualityProducerFixture } from "./helpers/quality-producer-fixture.js";
import { lockPauseFacts, recordPauseScope } from "../services/heartbeat-pause-intents.js";
import { pauseControlSchema, readPauseControl, type PauseReceipt } from "../services/heartbeat-pause-contract.js";
import { commitAgentResume } from "../services/heartbeat-agent-resume.js";
import { deliverPauseResume } from "../services/heartbeat-pause-delivery.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { claimHeartbeatWithRecoveryGuard, executeHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { producerAttempt, producerAttemptDetail } from "../services/work-products/producer-attempt.js";
import { markRetryDispatching } from "../services/workflow/retry-dispatch-state.js";

type Run = typeof heartbeatRuns.$inferSelect;
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>, db: Db, peer: Db;
beforeAll(async () => { owned = await createCommitSourceHarness(); db = owned.db; peer = owned.connect(); }, 60_000);
afterAll(async () => { await owned?.close(); });
const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const step = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;
const wake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
async function saveReceipt(p: PauseReceipt) {
  await db.update(agentWakeupRequests).set({ payload: pauseControlSchema.parse(p) }).where(eq(agentWakeupRequests.id, p.id));
}
async function savedReceipt(id: string) {
  const p = readPauseControl(await wake(id));
  if (p.kind !== "receipt") throw Error("receipt required");
  return p;
}

// C05 oracle: adopted plan:75-95,143-147: same frozen attempt, one atomic successor, no extra quality spend.
// This suite controls the positive stopped input; it does not claim an OS-stop or public-queue proof.
async function paused(parent: Run) {
  const saved = await db.transaction(async tx => {
    const t = tx as unknown as Db;
    const scope = await recordPauseScope(t, await lockPauseFacts(t, { companyId: parent.companyId,
      agentId: parent.agentId, heartbeatRunIds: [parent.id], cause: "manual_pause" }));
    await tx.update(agents).set({ status: "paused", pausedAt: new Date() }).where(eq(agents.id, parent.agentId));
    await tx.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, parent.id));
    await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, parent.wakeupRequestId!));
    return scope;
  });
  await commitAgentResume(db, parent.agentId);
  const original = saved.receipts.find(p => p.identity.heartbeatRunId === parent.id)!;
  const p = { ...await savedReceipt(original.id), stopped: { method: "legacy_execution_cleanup" as const,
    observedAt: new Date().toISOString(), heartbeatRunId: parent.id,
    executionEpoch: parent.executionEpoch, executionToken: parent.executionToken } };
  await saveReceipt(p);
  return { parent: await run(parent.id), p, step: await step(p.identity.workflow!.stepRunId), headId: saved.head.id };
}
async function ordinary(unstarted = true) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const workflowRunId = randomUUID(), stepRunId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05 writer", issuePrefix: "D" + companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "worker", status: "active", permissions: { canCreateAgents: true } });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "writer", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
  await db.insert(issues).values({ id: issueId, companyId, title: "write", status: "todo", assigneeAgentId: agentId });
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "write", issueId,
    status: "running", executionGeneration: 7, retryCount: 2, iterationIndex: 3 });
  if (unstarted) {
    const [w] = await insertWorkflowWakeRequest(db, { companyId, agentId, issueId, workflowRunId,
      workflowStepRunId: stepRunId, workflowExecutionGeneration: 7, source: "automation",
      idempotencyKey: `workflow-step-retry:${stepRunId}:2` });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId, wakeupRequestId: w!.id });
    await db.update(agentWakeupRequests).set({ runId: heartbeatId }).where(eq(agentWakeupRequests.id, w!.id));
  } else await admittedProducer(db, { companyId, agentId, issueId, stepRunId, heartbeatId, status: "running" });
  await db.update(heartbeatRuns).set({ processLossRetryCount: 4 }).where(eq(heartbeatRuns.id, heartbeatId));
  await db.update(issues).set({ executionRunId: heartbeatId, checkoutRunId: heartbeatId }).where(eq(issues.id, issueId));
  return paused(await run(heartbeatId));
}
async function rows(companyId: string) {
  return { wakes: await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
    eq(agentWakeupRequests.requestKind, "agent_pause_resume"))),
    runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(heartbeatRuns.id) };
}
async function usage(companyId: string) {
  return { usage: await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, companyId)).orderBy(qualityPolicyUsage.id),
    groups: await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, companyId)).orderBy(qualityActionGroups.id) };
}
async function assertChild(w: Awaited<ReturnType<typeof paused>>, h: Run,
  expected: { retryCount: number; iterationIndex: number }, nativeQuality = false) {
  expect(h).toMatchObject({ status: "queued", retryOfRunId: w.parent.id,
    processLossRetryCount: w.parent.processLossRetryCount, startedAt: null });
  const request = await wake(h.wakeupRequestId!);
  expect(request).toMatchObject({ source: "automation", requestedByActorType: "system",
    requestKind: "agent_pause_resume", reason: "agent_pause_resume", idempotencyKey: null, runId: h.id });
  expect(readWorkflowAttemptProof(request)).toMatchObject({ ...expected, parentHeartbeatRunId: w.parent.id,
    executionGeneration: w.step.executionGeneration, wakeupRequestId: request.id });
  expect((await savedReceipt(w.p.id)).delivery).toEqual({ wakeupRequestId: request.id, heartbeatRunId: h.id });
  const claimed = await claimHeartbeatWithRecoveryGuard(db, h, new Date());
  expect(claimed).not.toBeNull();
  if (nativeQuality) expect(await producerAttempt(db, claimed!, w.step)).toEqual(expected);
  else expect(await producerAttemptDetail(db, claimed!, w.step)).toEqual({ ...expected,
    rootHeartbeatRunId: w.parent.id, rootWakeupRequestId: w.parent.wakeupRequestId });
  const execute = vi.fn(async () => "started");
  await expect(executeHeartbeatWithRecoveryGuard(db, claimed!, execute)).resolves.toBe("started");
  expect(execute).toHaveBeenCalledTimes(1);
}
it.each([false, true])("C05 actual writer preserves a started/unclaimed original (%s)", async unstarted => {
  const w = await ordinary(unstarted);
  if (unstarted) {
    expect(w.parent).toMatchObject({ startedAt: null, workflowStepRunId: null, workflowExecutionGeneration: null });
    const before = await rows(w.parent.companyId);
    // SAME input: ordinary writer must keep refusing; only receipt-bound delivery grants this relation.
    await expect(insertWorkflowWakeRequest(db, { companyId: w.parent.companyId, agentId: w.parent.agentId,
      issueId: w.parent.issueId, workflowRunId: w.step.workflowRunId, workflowStepRunId: w.step.id,
      workflowExecutionGeneration: 7, source: "automation", requestKind: "agent_pause_resume" }, w.parent.id)).rejects.toThrow();
    expect(await rows(w.parent.companyId)).toEqual(before);
  }
  const h = await deliverPauseResume(db, w.p.id);
  expect(h).not.toBeNull();
  expect((await deliverPauseResume(peer, w.p.id))!.id).toBe(h!.id); // lost response replay
  expect((await rows(w.parent.companyId)).wakes).toHaveLength(1);
  await assertChild(w, h!, { retryCount: 2, iterationIndex: 3 });
}, 30_000);

it.each([false, true])("C05 issued QA root, unclaimed=%s: writer and existing claim/start share the real history", async unstarted => {
  const fixture = createClaimFixture(owned, x => x, [], []);
  const world = unstarted ? await fixture.world(true, false) : await fixture.world(true);
  const { c } = world;
  if (unstarted) {
    await fixture.pending(world);
    const request = (await correctionRows(c)).wakes[0]!;
    await db.transaction(tx => deliveryWriter(c)(tx, request));
  }
  const original = (await correctionRows(c)).heartbeats[0]!;
  const parent = unstarted ? original : (await claimHeartbeatWithRecoveryGuard(db, original, new Date()))!;
  if (unstarted) expect(parent).toMatchObject({ startedAt: null, workflowStepRunId: null, workflowExecutionGeneration: null });
  const w = await paused(parent), before = await usage(parent.companyId);
  if (unstarted) {
    const beforeRows = await rows(parent.companyId);
    await expect(insertWorkflowWakeRequest(db, { companyId: parent.companyId, agentId: parent.agentId,
      issueId: parent.issueId, missionId: w.p.identity.missionId, workflowRunId: w.step.workflowRunId,
      workflowStepRunId: w.step.id, workflowExecutionGeneration: w.step.executionGeneration,
      source: "automation", requestKind: "agent_pause_resume" }, parent.id)).rejects.toThrow();
    expect(await rows(parent.companyId)).toEqual(beforeRows);
  }
  const h = await deliverPauseResume(db, w.p.id);
  expect(h).not.toBeNull();
  await assertChild(w, h!, { retryCount: c.followup.target.retryCount, iterationIndex: c.followup.target.iterationIndex });
  expect(await usage(parent.companyId)).toEqual(before);
}, 30_000);

it("C05 native-quality original reuses its existing reservation and input admission", async () => {
  const f = await qualityProducerFixture(db, owned.root);
  await f.schedule(); const accepted = await f.admit();
  await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, accepted.heartbeatId));
  // The producer fixture completes display state during admission; model the still-running dispatched retry here.
  const admittedStep = await step(f.stepRunId);
  await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, f.stepRunId));
  expect(await markRetryDispatching(db, { workflowRunId: f.workflowRunId, stepRunId: f.stepRunId,
    expectedRetryNumber: 1, observedRetryCount: admittedStep.retryCount, requiredStatus: "pending" })).toBe(true);
  await db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.stepRunId));
  const w = await paused(await run(accepted.heartbeatId)), before = await usage(f.companyId);
  const [action] = await db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
  if (action!.target.kind !== "qa_addendum") throw Error("native addendum input required");
  const beforeRows = await rows(f.companyId);
  await db.update(qualityActions).set({ target: { ...action!.target, inputHash: "ff".repeat(32) } }).where(eq(qualityActions.id, f.actionId));
  await expect(deliverPauseResume(db, w.p.id)).rejects.toThrow();
  expect(await rows(f.companyId)).toEqual(beforeRows);
  await db.update(qualityActions).set({ target: action!.target }).where(eq(qualityActions.id, f.actionId));
  const h = await deliverPauseResume(db, w.p.id);
  expect(h).not.toBeNull();
  await assertChild(w, h!, { retryCount: 1, iterationIndex: 0 }, true);
  expect(await usage(f.companyId)).toEqual(before);
}, 30_000);

it("C05 two PostgreSQL connections contend before delivery and reuse the same actual child", async () => {
  const w = await ordinary(), second = owned.connect();
  let ready!: () => void, release!: () => void, pid = 0;
  const held = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const holder = db.transaction(async tx => {
    pid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
    await tx.select().from(agents).where(eq(agents.id, w.parent.agentId)).for("no key update");
    ready(); await gate;
  });
  await held;
  const a = deliverPauseResume(peer, w.p.id), b = deliverPauseResume(second, w.p.id);
  // Attach both rejection handlers before testing the gate so a failure cannot become unhandled.
  const result = Promise.allSettled([a, b]);
  try {
    await vi.waitFor(async () => {
      const blocked = await second.execute(sql`WITH RECURSIVE blocked(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE datname=current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT pid FROM blocked`);
      expect(blocked.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 10_000 });
  } finally { release(); await holder; }
  const results = await result;
  expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
  const children = results.map(r => r.status === "fulfilled" ? r.value : null);
  expect(children[0]).not.toBeNull(); expect(children[1]!.id).toBe(children[0]!.id);
  expect((await rows(w.parent.companyId)).wakes).toHaveLength(1);
  expect((await rows(w.parent.companyId)).runs).toHaveLength(2);
}, 30_000);

it.each(["heartbeat", "receipt"])("C05 a real %s write failure rolls back every delivery write", async stage => {
  const w = await ordinary(), before = await rows(w.parent.companyId), p = await savedReceipt(w.p.id);
  const name = "c05_" + randomUUID().replaceAll("-", ""), table = stage === "heartbeat" ? "heartbeat_runs" : "agent_wakeup_requests";
  const when = stage === "heartbeat" ? "NEW.retry_of_run_id IS NOT NULL" : "NEW.id='" + w.p.id + "'::uuid";
  await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $c05$
    BEGIN IF NEW.company_id='${w.parent.companyId}'::uuid AND (${when}) THEN
    RAISE EXCEPTION 'c05_delivery_write_failure'; END IF; RETURN NEW; END; $c05$`));
  await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE ${stage === "heartbeat" ? "INSERT" : "UPDATE"} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  try {
    await expect(deliverPauseResume(peer, w.p.id)).rejects.toThrow("c05_delivery_write_failure");
    expect(await rows(w.parent.companyId)).toEqual(before);
    expect(await savedReceipt(w.p.id)).toEqual(p);
    expect((await db.select().from(issues).where(eq(issues.id, w.parent.issueId!)))[0])
      .toMatchObject({ executionRunId: w.parent.id, checkoutRunId: w.parent.id });
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
  expect(await deliverPauseResume(db, w.p.id)).not.toBeNull();
}, 30_000);

it.each(["approval", "stopped", "scope", "invalidated", "permission", "generation", "authority", "forged", "live"])
("C05 refuses %s before writing a successor", async fault => {
  const w = await ordinary();
  if (fault === "approval") await saveReceipt({ ...w.p, resumeScopeId: null });
  if (fault === "stopped") await saveReceipt({ ...w.p, stopped: null });
  if (fault === "invalidated") await saveReceipt({ ...w.p, invalidated: { cause: "user_cancel", at: new Date().toISOString() } });
  if (fault === "permission") await db.update(agents).set({ permissions: {} }).where(eq(agents.id, w.parent.agentId));
  if (fault === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, w.step.id));
  if (fault === "authority") await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, w.step.workflowRunId));
  if (fault === "forged") await db.update(agentWakeupRequests).set({ source: "automation" }).where(eq(agentWakeupRequests.id, w.p.id));
  if (fault === "live") await db.insert(heartbeatRuns).values({ companyId: w.parent.companyId, agentId: w.parent.agentId,
    issueId: w.parent.issueId, status: "running" });
  if (fault === "scope") await db.transaction(async tx => {
    const t = tx as unknown as Db;
    await recordPauseScope(t, await lockPauseFacts(t, { companyId: w.parent.companyId, agentId: w.parent.agentId,
      heartbeatRunIds: [], cause: "manual_pause" }));
  });
  const before = await rows(w.parent.companyId);
  await expect(deliverPauseResume(peer, w.p.id)).rejects.toThrow();
  expect(await rows(w.parent.companyId)).toEqual(before);
}, 30_000);

it("C05 changed QA input binding is refused by the existing root before delivery", async () => {
  const { c } = await createClaimFixture(owned, x => x, [], []).world(true);
  const w = await paused((await correctionRows(c)).heartbeats[0]!);
  await db.update(workflowStepOutputBindings).set({ workProductId: c.s.productId })
    .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
  const before = await rows(w.parent.companyId), quality = await usage(w.parent.companyId);
  await expect(deliverPauseResume(peer, w.p.id)).rejects.toThrow();
  expect(await rows(w.parent.companyId)).toEqual(before);
  expect(await usage(w.parent.companyId)).toEqual(quality);
}, 30_000);

it.each(["waiting", "dispatching"])("C05 preserves %s retry ownership, due time and counters", async state => {
  const w = await ordinary();
  const retry = { state, retryNumber: 2, maxRetries: 3, nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
    sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null };
  await db.update(workflowStepRuns).set({ metadata: { workflowRetry: retry } }).where(eq(workflowStepRuns.id, w.step.id));
  if (state === "dispatching") await insertWorkflowWakeRequest(db, { companyId: w.parent.companyId,
    agentId: w.parent.agentId, issueId: w.parent.issueId, workflowRunId: w.step.workflowRunId,
    workflowStepRunId: w.step.id, workflowExecutionGeneration: 7, source: "automation",
    idempotencyKey: `workflow-step-retry:${w.step.id}:2` });
  const before = await rows(w.parent.companyId), metadata = (await step(w.step.id)).metadata;
  expect(await deliverPauseResume(peer, w.p.id)).toBeNull();
  expect(await rows(w.parent.companyId)).toEqual(before);
  expect((await step(w.step.id)).metadata).toEqual(metadata);
  expect((await savedReceipt(w.p.id)).delivery).toBeNull();
}, 30_000);
