import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, qualityActions, qualityActionGroups,
  qualityPolicyUsage, workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { qualityProducerFixture } from "./helpers/quality-producer-fixture.js";
import { createCommitSourceHarness } from "./helpers/c02-fixture.js";
import { createClaimFixture } from "./helpers/c02-claim-race-fixture.js";
import { correctionRows } from "./helpers/c02-delivery-fixture.js";
import { lockPauseFacts, recordPauseScope } from "../services/heartbeat-pause-intents.js";
import type { PauseReceipt } from "../services/heartbeat-pause-contract.js";
import { readPauseChildProof } from "../services/heartbeat-pause-admission.js";
import { producerAttempt, producerAttemptDetail } from "../services/work-products/producer-attempt.js";
import { claimHeartbeatWithRecoveryGuard, executeHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY, readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";

type Run = typeof heartbeatRuns.$inferSelect;
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>, db: Db, peer: Db;
beforeAll(async () => { owned = await createCommitSourceHarness(); db = owned.db; peer = owned.connect(); }, 60_000);
afterAll(async () => { await owned?.close(); });
const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const readStep = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;
async function receipt(p: PauseReceipt, connection = db) {
  await connection.update(agentWakeupRequests).set({ payload: p }).where(eq(agentWakeupRequests.id, p.id));
}

// C05 oracle: adopted plan:88-110. A pause is the SAME retry/iteration, not another quality attempt.
// Controlled delivery/stopped inputs below test identity/claim/start, not the still-unimplemented delivery/OS-stop path.
async function delivered(parent: Run) {
  const saved = await db.transaction(async tx => {
    const t = tx as unknown as Db;
    const value = await recordPauseScope(t, await lockPauseFacts(t, { companyId: parent.companyId,
      agentId: parent.agentId, heartbeatRunIds: [parent.id], cause: "manual_pause" }));
    await tx.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, parent.id));
    return value;
  });
  const original = saved.receipts.find(p => p.identity.heartbeatRunId === parent.id)!;
  const approved: PauseReceipt = { ...original, resumeScopeId: saved.scope!.id, stopped: {
    method: "legacy_execution_cleanup", observedAt: new Date().toISOString(), heartbeatRunId: parent.id,
    executionEpoch: parent.executionEpoch, executionToken: parent.executionToken } };
  await receipt(approved);
  const i = approved.identity, f = i.workflow!, childId = randomUUID();
  const [originalWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parent.wakeupRequestId!));
  const values = { companyId: i.companyId, agentId: i.agentId, issueId: i.issueId, missionId: i.missionId,
    workflowRunId: f.runId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: f.executionGeneration,
    source: "automation", requestedByActorType: "system", requestKind: "agent_pause_resume", reason: "agent_pause_resume" };
  // Existing writer handles started parents. New unstarted-parent delivery is controlled reader input only.
  const wake = parent.startedAt ? (await insertWorkflowWakeRequest(db, values, parent.id))[0]! :
    (await db.insert(agentWakeupRequests).values({ ...values, id: randomUUID() }).returning())[0]!;
  if (!parent.startedAt) await db.update(agentWakeupRequests).set({ payload: {
    [WORKFLOW_ATTEMPT_PROOF_KEY]: { ...readWorkflowAttemptProof(originalWake!),
      wakeupRequestId: wake.id, parentHeartbeatRunId: parent.id } } }).where(eq(agentWakeupRequests.id, wake.id));
  const [child] = await db.insert(heartbeatRuns).values({ id: childId, companyId: i.companyId, agentId: i.agentId,
    issueId: i.issueId, wakeupRequestId: wake.id, retryOfRunId: parent.id,
    processLossRetryCount: parent.processLossRetryCount, invocationSource: "automation" }).returning();
  await db.update(agentWakeupRequests).set({ runId: childId }).where(eq(agentWakeupRequests.id, wake.id));
  const p: PauseReceipt = { ...approved, delivery: { wakeupRequestId: wake.id, heartbeatRunId: childId } };
  await receipt(p);
  return { parent, child: child!, p, step: await readStep(f.stepRunId), headId: saved.head.id };
}
async function ordinary(unstarted = false) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05 identity", issuePrefix: "I" + companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "worker", status: "active", permissions: { canCreateAgents: true } });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "identity", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "test" });
  await db.insert(issues).values({ id: issueId, companyId, title: "write", status: "todo", assigneeAgentId: agentId });
  await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "write", issueId,
    status: "running", executionGeneration: 7, retryCount: 2, iterationIndex: 3 });
  if (unstarted) {
    const [wake] = await insertWorkflowWakeRequest(db, { companyId, agentId, issueId, workflowRunId: runId,
      workflowStepRunId: stepId, workflowExecutionGeneration: 7, source: "automation",
      idempotencyKey: `workflow-step-retry:${stepId}:2` });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId, wakeupRequestId: wake!.id });
    await db.update(agentWakeupRequests).set({ runId: heartbeatId }).where(eq(agentWakeupRequests.id, wake!.id));
  } else await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId, status: "running" });
  return delivered(await readRun(heartbeatId));
}

it.each([false, true])("C05 preserves the original root/counters, including receipt-proven unstarted=%s", async unstarted => {
  const w = await ordinary(unstarted), rootWake = w.parent.wakeupRequestId!;
  expect((await readPauseChildProof(db, w.child))?.receipt.id).toBe(w.p.id);
  await expect(producerAttemptDetail(db, { ...w.parent, startedAt: null }, w.step)).rejects.toThrow();
  const claimed = await claimHeartbeatWithRecoveryGuard(db, w.child, new Date());
  expect(claimed).toMatchObject({ status: "running", retryOfRunId: w.parent.id, processLossRetryCount: w.parent.processLossRetryCount });
  expect(await producerAttemptDetail(db, claimed!, w.step)).toEqual({ retryCount: 2, iterationIndex: 3,
    rootHeartbeatRunId: w.parent.id, rootWakeupRequestId: rootWake });
  const execute = vi.fn(async () => "started");
  await expect(executeHeartbeatWithRecoveryGuard(db, claimed!, execute)).resolves.toBe("started");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await claimHeartbeatWithRecoveryGuard(db, claimed!, new Date())).toBeNull();
  const again = await delivered(await readRun(claimed!.id));
  const second = await claimHeartbeatWithRecoveryGuard(db, again.child, new Date());
  expect(await producerAttemptDetail(db, second!, again.step)).toEqual({ retryCount: 2, iterationIndex: 3,
    rootHeartbeatRunId: w.parent.id, rootWakeupRequestId: rootWake });
});

// Controlled already-claimed input makes the old missing-start-check and corrected refusal directly distinguishable.
async function startInput(w: Awaited<ReturnType<typeof ordinary>>) {
  return (await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(),
    workflowStepRunId: w.step.id, workflowExecutionGeneration: w.step.executionGeneration })
    .where(eq(heartbeatRuns.id, w.child.id)).returning())[0]!;
}
async function change(w: Awaited<ReturnType<typeof ordinary>>, kind: string) {
  if (kind === "invalidated") await receipt({ ...w.p, invalidated: { cause: "user_cancel", at: new Date().toISOString() } });
  if (kind === "scope") await db.transaction(async tx => {
    const t = tx as unknown as Db;
    await recordPauseScope(t, await lockPauseFacts(t, { companyId: w.child.companyId, agentId: w.child.agentId,
      heartbeatRunIds: [], cause: "manual_pause" }));
  });
  if (kind === "permission") await db.update(agents).set({ permissions: {} }).where(eq(agents.id, w.child.agentId));
  if (kind === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, w.step.id));
}
it.each(["invalidated", "scope", "permission", "generation"])("C05 %s wins before BOTH claim and start", async kind => {
  for (const boundary of ["claim", "start"]) {
    const w = await ordinary(), h = boundary === "claim" ? w.child : await startInput(w);
    await change(w, kind);
    const execute = vi.fn(async () => "forbidden");
    await expect(boundary === "claim" ? claimHeartbeatWithRecoveryGuard(db, h, new Date()) :
      executeHeartbeatWithRecoveryGuard(db, h, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    const after = await readRun(h.id);
    expect(after.status).toBe(boundary === "claim" ? "queued" : "running");
    expect(after.startedAt).toEqual(h.startedAt);
  }
});

// C05 storage fence: only an unstarted, wholly untyped child may use the pre-claim form.
it.each(["started-null", "step-null", "generation-null"])("C05 rejects %s delivered child at scope storage", async kind => {
  const w = await ordinary();
  await db.update(heartbeatRuns).set({
    status: kind === "started-null" ? "running" : "queued",
    startedAt: kind === "started-null" ? new Date() : null,
    workflowStepRunId: kind === "generation-null" ? w.step.id : null,
    workflowExecutionGeneration: kind === "step-null" ? w.step.executionGeneration : null,
  }).where(eq(heartbeatRuns.id, w.child.id));
  const before = await readRun(w.child.id);
  await expect(change(w, "scope")).rejects.toThrow("heartbeat_pause_scope_unproven_or_changed");
  const [head] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.headId));
  expect(head!.payload).toMatchObject({ scopeId: w.p.ownerScopeId });
  expect(await readRun(w.child.id)).toEqual(before);
});

it.each(["public", "parent", "delivery", "stop", "counter", "missing-wake", "duplicate"])("C05 rejects %s evidence", async kind => {
  const w = await ordinary();
  if (kind === "public") await db.update(agentWakeupRequests).set({ source: "on_demand", requestedByActorType: "user", requestedByActorId: "operator" })
    .where(eq(agentWakeupRequests.id, w.p.id));
  if (kind === "parent") await db.update(heartbeatRuns).set({ retryOfRunId: w.child.id }).where(eq(heartbeatRuns.id, w.child.id));
  if (kind === "delivery") await db.update(agentWakeupRequests).set({ runId: w.parent.id })
    .where(eq(agentWakeupRequests.id, w.child.wakeupRequestId!));
  if (kind === "stop") await receipt({ ...w.p, stopped: null });
  if (kind === "counter") await receipt({ ...w.p, identity: { ...w.p.identity,
    workflow: { ...w.p.identity.workflow!, retryCount: 99 } } });
  if (kind === "missing-wake") await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, w.child.id));
  if (kind === "duplicate") await db.insert(heartbeatRuns).values({ companyId: w.child.companyId,
    agentId: w.child.agentId, issueId: w.child.issueId, workflowStepRunId: w.step.id, workflowExecutionGeneration: 7, status: "running" });
  await expect(claimHeartbeatWithRecoveryGuard(db, await readRun(w.child.id), new Date())).rejects.toThrow();
  expect((await readRun(w.child.id)).status).toBe("queued");
});

it.each(["claim", "start"])("C05 waits on another connection's exact receipt before %s", async boundary => {
  const w = await ordinary(), h = boundary === "claim" ? w.child :
    (await claimHeartbeatWithRecoveryGuard(db, w.child, new Date()))!;
  let release!: () => void, ready!: () => void, pid = 0;
  const gate = new Promise<void>(r => { release = r; }), held = new Promise<void>(r => { ready = r; });
  const holder = db.transaction(async tx => {
    pid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
    await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.p.id)).for("update");
    ready(); await gate;
    await receipt({ ...w.p, invalidated: { cause: "user_cancel", at: new Date().toISOString() } }, tx as unknown as Db);
  });
  await held;
  const execute = vi.fn(async () => "forbidden");
  const operation = (boundary === "claim" ? claimHeartbeatWithRecoveryGuard(peer, h, new Date()) :
    executeHeartbeatWithRecoveryGuard(peer, h, execute)).then(() => null, error => error);
  try {
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%agent_wakeup_requests%'`);
      expect(rows.length).toBeGreaterThan(0); expect(Number(rows[0]!.pid)).not.toBe(pid);
    });
    expect(execute).not.toHaveBeenCalled();
  } finally { release(); await holder; }
  expect(await operation).toBeInstanceOf(Error);
  expect(execute).not.toHaveBeenCalled(); expect((await readRun(h.id)).startedAt).toEqual(h.startedAt);
});

it.each(["claim", "start"])("C05 holds receipt through the actual %s boundary", async boundary => {
  const w = await ordinary(), h = boundary === "claim" ? w.child :
    (await claimHeartbeatWithRecoveryGuard(db, w.child, new Date()))!;
  let release!: () => void, ready!: () => void, pid = 0;
  const gate = new Promise<void>(r => { release = r; }), held = new Promise<void>(r => { ready = r; });
  const execute = vi.fn(async () => "started");
  const holder = db.transaction(async tx => {
    const t = tx as unknown as Db;
    pid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
    if (boundary === "claim") expect(await claimHeartbeatWithRecoveryGuard(t, h, new Date())).not.toBeNull();
    else await executeHeartbeatWithRecoveryGuard(t, h, execute);
    ready(); await gate;
  });
  await held;
  const update = peer.transaction(async tx => {
    await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.p.id)).for("update");
    await receipt({ ...w.p, invalidated: { cause: "user_cancel", at: new Date().toISOString() } }, tx as unknown as Db);
  });
  try {
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%agent_wakeup_requests%'`);
      expect(rows.length).toBeGreaterThan(0); expect(Number(rows[0]!.pid)).not.toBe(pid);
    });
    if (boundary === "start") expect(execute).toHaveBeenCalledTimes(1);
  } finally { release(); await Promise.all([holder, update]); }
});

it("C05 releases the transaction before awaiting the adapter lifetime", async () => {
  const w = await ordinary(), h = (await claimHeartbeatWithRecoveryGuard(db, w.child, new Date()))!;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const execution = executeHeartbeatWithRecoveryGuard(db, h, () => { entered(); return gate; });
  await ready;
  try {
    await peer.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.p.id)).for("update");
    });
  } finally { release(); await execution; }
});

async function usage(companyId: string) {
  return { usage: await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, companyId)).orderBy(qualityPolicyUsage.id),
    groups: await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, companyId)).orderBy(qualityActionGroups.id) };
}
it.each(["native", "correction"])("C05 permits %s pause ancestry without another quality reservation; rejects new input/owner", async kind => {
  let parent: Run, actionId: string, binding: { id: string; before: string; after: string } | null = null;
  if (kind === "native") {
    const f = await qualityProducerFixture(db, owned.root);
    await f.schedule(); const a = await f.admit();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, a.heartbeatId));
    parent = await readRun(a.heartbeatId); actionId = f.actionId;
  } else {
    const { c } = await createClaimFixture(owned, x => x, [], []).world(true);
    const root = (await correctionRows(c)).heartbeats[0]!;
    parent = (await claimHeartbeatWithRecoveryGuard(db, root, new Date()))!;
    if (c.s.p.authority.kind !== "quality_current_output") throw Error("quality correction fixture required");
    actionId = c.s.p.authority.actionId;
    binding = { id: c.s.f.bindingId, before: c.s.productId, after: c.stored.revisions[0]!.workProductId };
  }
  const w = await delivered(parent), before = await usage(parent.companyId);
  // Fixture contracts: one native scheduled retry, or the issued QA target retry=1/iteration=2.
  const expected = kind === "native" ? { retryCount: 1, iterationIndex: 0 } : { retryCount: 1, iterationIndex: 2 };
  const h = (await claimHeartbeatWithRecoveryGuard(db, w.child, new Date()))!;
  expect(await producerAttempt(db, h, w.step)).toEqual(expected);
  if (kind === "correction") expect(await producerAttemptDetail(db, h, w.step)).toEqual({
    ...expected, rootHeartbeatRunId: parent.id, rootWakeupRequestId: parent.wakeupRequestId });
  const execute = vi.fn(async () => "started");
  await executeHeartbeatWithRecoveryGuard(db, h, execute);
  expect(execute).toHaveBeenCalledTimes(1); expect(await usage(parent.companyId)).toEqual(before);
  const [action] = await db.select().from(qualityActions).where(eq(qualityActions.id, actionId));
  if (binding) await db.update(workflowStepOutputBindings).set({ workProductId: binding.before })
    .where(eq(workflowStepOutputBindings.id, binding.id));
  else {
    if (action!.target.kind !== "qa_addendum") throw Error("native addendum input required");
    await db.update(qualityActions).set({ target: { ...action!.target, inputHash: "ff".repeat(32) } })
      .where(eq(qualityActions.id, actionId));
  }
  execute.mockClear();
  await expect(executeHeartbeatWithRecoveryGuard(db, h, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(await usage(parent.companyId)).toEqual(before);
  if (binding) await db.update(workflowStepOutputBindings).set({ workProductId: binding.after })
    .where(eq(workflowStepOutputBindings.id, binding.id));
  await db.update(qualityActions).set({ target: action!.target, cancelRequestedAt: new Date() }).where(eq(qualityActions.id, actionId));
  await expect(executeHeartbeatWithRecoveryGuard(db, h, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(await usage(parent.companyId)).toEqual(before);
  await db.update(qualityActions).set({ cancelRequestedAt: null }).where(eq(qualityActions.id, actionId));
  const [other] = await db.insert(agents).values({ companyId: parent.companyId, name: "new owner" }).returning();
  await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, h.issueId!));
  await expect(executeHeartbeatWithRecoveryGuard(db, h, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(await usage(parent.companyId)).toEqual(before);
  expect(await readStep(w.step.id)).toMatchObject(expected);
}, 30_000);
