import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { lockCurrentScope, lockPauseFacts, recordPauseScope } from "../services/heartbeat-pause-intents.js";
import { PAUSE_CONTROL_COLUMNS, readPauseControl, type PauseReceipt, type PauseScopeInput } from "../services/heartbeat-pause-contract.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, peer: Db;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-c05-scope-");
  db = createDb(temp.connectionString); peer = createDb(temp.connectionString);
}, 60_000);
afterAll(async () => { await db?.$client.end(); await peer?.$client.end(); await temp?.cleanup(); });

// C05 expectations come from c05-minimum-plan-adopted.md sections 1-3, not a replay of the writer.
// This suite proves storage only: no signal, quiescence, resume delivery or adapter execution.
async function seed(count = 2, queued = false) {
  const companyId = randomUUID(), agentId = randomUUID(), workflowId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "C05", issuePrefix: "P" + companyId.slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "worker", permissions: { canCreateAgents: true } });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "pause", stepsJson: [] });
  const attempts: { missionId: string; issueId: string; runId: string; stepId: string; heartbeatId: string; wakeId: string }[] = [];
  for (let index = 0; index < count; index++) {
    const missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), stepId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "mission " + index });
    await db.insert(issues).values({ id: issueId, companyId, missionId, assigneeAgentId: agentId, title: "attempt " + index });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, triggeredBy: "board", dispatchAuthorityVersion: 4 });
    await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "write", issueId,
      status: "running", executionGeneration: 7, retryCount: 2, iterationIndex: 3 });
    let admitted: { wakeId: string };
    if (queued) {
      const [wake] = await insertWorkflowWakeRequest(db, { companyId, agentId, issueId, missionId,
        workflowRunId: runId, workflowStepRunId: stepId, workflowExecutionGeneration: 7,
        source: "automation", idempotencyKey: `workflow-step-retry:${stepId}:2` });
      await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId, wakeupRequestId: wake.id });
      await db.update(agentWakeupRequests).set({ runId: heartbeatId }).where(eq(agentWakeupRequests.id, wake.id));
      admitted = { wakeId: wake.id };
    } else admitted = await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId, status: "running" });
    attempts.push({ missionId, issueId, runId, stepId, heartbeatId, wakeId: admitted.wakeId });
  }
  return { companyId, agentId, workflowId, attempts };
}
type World = Awaited<ReturnType<typeof seed>>;
function input(w: World, heartbeatRunIds = w.attempts.map(a => a.heartbeatId)): PauseScopeInput {
  return { companyId: w.companyId, agentId: w.agentId, heartbeatRunIds, cause: "manual_pause" };
}
async function pause(connection: Db, value: PauseScopeInput) {
  return connection.transaction(async tx => {
    const t = tx as unknown as Db;
    return recordPauseScope(t, await lockPauseFacts(t, value));
  });
}
async function controls(connection: Db, agentId: string) {
  return connection.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.source, "internal_agent_pause_v1"))).orderBy(agentWakeupRequests.id);
}
async function patchReceipt(p: PauseReceipt) {
  await db.update(agentWakeupRequests).set({ payload: p }).where(eq(agentWakeupRequests.id, p.id));
}

it("C05: two missions retain their own original heartbeat/wake and admitted retry identity", async () => {
  const w = await seed(), before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId)).orderBy(heartbeatRuns.id);
  const saved = await pause(db, input(w));
  const stored = (await controls(peer, w.agentId)).map(readPauseControl);
  expect(stored.filter(p => p.kind === "head")).toHaveLength(1);
  expect(saved.scope?.receiptIds.slice().sort()).toEqual(saved.receipts.map(p => p.id).sort());
  expect(saved.receipts).toHaveLength(2);
  for (const a of w.attempts) {
    const r = saved.receipts.find(p => p.identity.heartbeatRunId === a.heartbeatId)!;
    expect(r.identity).toMatchObject({ companyId: w.companyId, agentId: w.agentId, missionId: a.missionId,
      issueId: a.issueId, wakeupRequestId: a.wakeId, observedPermissions: { canCreateAgents: true },
      workflow: { workflowId: w.workflowId, runId: a.runId, stepRunId: a.stepId, observedAuthorityVersion: 4,
        executionGeneration: 7, retryCount: 2, iterationIndex: 3 } });
    expect(r.originScopeId).toBe(saved.scope!.id); expect(r.ownerScopeId).toBe(saved.scope!.id);
    expect(r.resumeScopeId).toBeNull(); expect(r.delivery).toBeNull();
  }
  expect(await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId)).orderBy(heartbeatRuns.id)).toEqual(before);
  for (const row of await controls(peer, w.agentId)) expect(row).toMatchObject({
    source: "internal_agent_pause_v1", requestedByActorType: "system", requestedByActorId: "runtime:agent-pause:v1",
    requestKind: "agent_pause_control_v1", status: "skipped", runId: null,
  });
});

it("C05: queued originals keep NULL heartbeat capabilities and non-pause causes never become resume approvals", async () => {
  for (const cause of ["manual_pause", "user_cancel", "terminate", "budget"] as const) {
    const w = await seed(1, true), a = w.attempts[0];
    const saved = await pause(db, { ...input(w), cause }), r = saved.receipts[0];
    expect(r.identity).toMatchObject({ heartbeatRunId: a.heartbeatId, wakeupRequestId: a.wakeId,
      workflow: { executionGeneration: 7, retryCount: 2, iterationIndex: 3 },
      execution: { epoch: null, token: null, ownerId: null, ownerLeaseEpoch: null, ownerLeaseToken: null } });
    expect(r.cause).toBe(cause); expect(r.resumeScopeId).toBeNull();
    expect(r.invalidated?.cause ?? null).toBe(cause === "manual_pause" ? null : cause);
    const [h] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.heartbeatId));
    expect(h.workflowStepRunId).toBeNull(); expect(h.workflowExecutionGeneration).toBeNull();
    expect(h.status).toBe("queued"); expect(h.errorCode).toBeNull();
  }
});

it("C05: repeat pause keeps origin, old approval, invalidation and already-delivered links without re-adopting them", async () => {
  const w = await seed(3), first = await pause(db, input(w));
  const ordered = w.attempts.map(a => first.receipts.find(p => p.identity.heartbeatRunId === a.heartbeatId)!);
  const approved: PauseReceipt = { ...ordered[0], resumeScopeId: first.scope!.id };
  const invalid: PauseReceipt = { ...ordered[1], resumeScopeId: first.scope!.id,
    invalidated: { cause: "user_cancel", at: new Date().toISOString() } };
  const a = w.attempts[2], childId = randomUUID();
  const [wake] = await insertWorkflowWakeRequest(db, { companyId: w.companyId, agentId: w.agentId,
    source: "automation", requestedByActorType: "system", requestKind: "adapter_failed_retry", reason: "adapter_failed_retry",
    issueId: a.issueId, missionId: a.missionId, workflowRunId: a.runId, workflowStepRunId: a.stepId,
    workflowExecutionGeneration: 7 }, a.heartbeatId);
  await db.insert(heartbeatRuns).values({ id: childId, companyId: w.companyId, agentId: w.agentId,
    issueId: a.issueId, wakeupRequestId: wake.id, retryOfRunId: a.heartbeatId,
    workflowStepRunId: a.stepId, workflowExecutionGeneration: 7 });
  await db.update(agentWakeupRequests).set({ runId: childId }).where(eq(agentWakeupRequests.id, wake.id));
  const delivered: PauseReceipt = { ...ordered[2], resumeScopeId: first.scope!.id,
    delivery: { wakeupRequestId: wake.id, heartbeatRunId: childId } };
  await patchReceipt(approved); await patchReceipt(invalid); await patchReceipt(delivered);
  await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled" })
    .where(inArray(heartbeatRuns.id, w.attempts.map(p => p.heartbeatId)));
  // Current display counters/permissions changed after the original admission: never rewrite history.
  await db.update(workflowStepRuns).set({ executionGeneration: 8, retryCount: 99, iterationIndex: 88 })
    .where(inArray(workflowStepRuns.id, w.attempts.map(p => p.stepId)));
  await db.update(workflowRuns).set({ dispatchAuthorityVersion: 5 })
    .where(inArray(workflowRuns.id, w.attempts.map(p => p.runId)));
  await db.update(agents).set({ permissions: {} }).where(eq(agents.id, w.agentId));
  const second = await pause(peer, input(w, []));
  expect(second.scope!.id).not.toBe(first.scope!.id); expect(second.scope!.previousScopeId).toBe(first.scope!.id);
  expect(second.receipts.map(p => p.id).sort()).toEqual([approved.id, invalid.id].sort());
  for (const old of [approved, invalid]) {
    const now = second.receipts.find(p => p.id === old.id)!;
    expect(now).toEqual({ ...old, ownerScopeId: second.scope!.id });
    expect(now.resumeScopeId).not.toBe(now.ownerScopeId); // Old approval cannot authorize this scope.
  }
  const unchanged = (await controls(db, w.agentId)).find(p => p.id === delivered.id)!;
  expect(readPauseControl(unchanged)).toEqual(delivered);
  await expect(peer.transaction(tx => lockCurrentScope(tx as unknown as Db, w.agentId, first.scope!.id))).rejects.toThrow();
  const third = await pause(db, input(w, []));
  expect(third.receipts.find(p => p.id === invalid.id)?.invalidated).toEqual(invalid.invalidated);
  expect((await controls(peer, w.agentId)).map(readPauseControl).filter(p => p.kind === "receipt")).toHaveLength(3);
});

it("C05: separate PostgreSQL connections serialize first head creation and scope commits", async () => {
  const w = await seed(0);
  let release!: () => void, ready!: () => void, contender!: () => void, firstPid = 0, secondPid = 0;
  const gate = new Promise<void>(r => { release = r; }), holding = new Promise<void>(r => { ready = r; });
  const entered = new Promise<void>(r => { contender = r; });
  const first = db.transaction(async tx => {
    const t = tx as unknown as Db;
    firstPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
    const result = await recordPauseScope(t, await lockPauseFacts(t, input(w)));
    ready(); await gate; return result;
  });
  await holding;
  const second = peer.transaction(async tx => {
    secondPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
    contender();
    const t = tx as unknown as Db;
    return recordPauseScope(t, await lockPauseFacts(t, input(w)));
  });
  const joined = Promise.allSettled([first, second]);
  await entered;
  try {
    let blocked = false;
    const deadline = Date.now() + 5000;
    do {
      const rows = await db.$client.unsafe("select $1::int = ANY(pg_blocking_pids($2::int)) as blocked", [firstPid, secondPid]);
      blocked = rows[0]?.blocked === true;
      if (!blocked) await new Promise(r => setTimeout(r, 20));
    } while (!blocked && Date.now() < deadline);
    expect(firstPid).not.toBe(secondPid); expect(blocked).toBe(true);
  } finally { release(); await joined; }
  const [a, b] = await Promise.all([first, second]);
  const rows = (await controls(db, w.agentId)).map(readPauseControl);
  expect(rows.filter(p => p.kind === "head")).toHaveLength(1);
  expect(rows.filter(p => p.kind === "scope")).toHaveLength(2);
  expect(b.head.id).toBe(a.head.id); expect(b.scope!.previousScopeId).toBe(a.scope!.id);
  const current = await db.transaction(tx => lockCurrentScope(tx as unknown as Db, w.agentId, b.scope!.id));
  expect(current.head.scopeId).toBe(b.scope!.id);
}, 30_000);

it("C05: a real middle insert failure rolls back head, scope and every receipt", async () => {
  const w = await seed();
  await db.$client.unsafe(`CREATE FUNCTION c05_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.source='internal_agent_pause_v1' AND NEW.payload->>'kind'='receipt'
      AND NEW.payload->'identity'->>'heartbeatRunId'='${w.attempts[1].heartbeatId}'
    THEN RAISE EXCEPTION 'c05 injected middle write'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER c05_fail_receipt BEFORE INSERT ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION c05_fail_receipt()`);
  try { await expect(pause(db, input(w))).rejects.toThrow(); }
  finally { await db.$client.unsafe("DROP TRIGGER c05_fail_receipt ON agent_wakeup_requests; DROP FUNCTION c05_fail_receipt()"); }
  expect(await controls(peer, w.agentId)).toHaveLength(0);
  expect(await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, w.agentId))).toHaveLength(2);
  expect((await pause(peer, input(w))).receipts).toHaveLength(2);
});

it("C05: payload-only forgery, mismatched provenance and foreign original identities are rejected", async () => {
  const w = await seed(), other = await seed(1), fakeId = randomUUID();
  const [fake] = await db.insert(agentWakeupRequests).values({ id: fakeId, companyId: w.companyId, agentId: w.agentId,
    source: "on_demand", requestedByActorType: "board", requestedByActorId: "operator", status: "skipped",
    requestKind: PAUSE_CONTROL_COLUMNS.requestKind, payload: { schemaVersion: 1, kind: "head",
      id: fakeId, companyId: w.companyId, agentId: w.agentId, scopeId: null } }).returning();
  expect(() => readPauseControl(fake)).toThrow();
  const saved = await pause(db, input(w));
  expect(saved.head.id).not.toBe(fakeId);
  const receipt = saved.receipts.find(p => p.identity.heartbeatRunId === w.attempts[0].heartbeatId)!;
  const row = (await controls(db, w.agentId)).find(p => p.id === receipt.id)!;
  for (const patch of [{ source: "automation" }, { requestedByActorType: "board" }, { requestedByActorId: "operator" },
    { requestKind: "on_demand" }, { status: "queued" }]) {
    expect(() => readPauseControl({ ...row, ...patch })).toThrow();
  }
  const mutations: Partial<typeof agentWakeupRequests.$inferInsert>[] = [
    { source: "automation" }, { companyId: other.companyId }, { agentId: other.agentId },
    { payload: { ...receipt, schemaVersion: 2 } }, { payload: { ...receipt, unknownField: true } },
    { payload: { ...receipt, identity: { ...receipt.identity, heartbeatRunId: w.attempts[1].heartbeatId } } },
    { payload: { ...receipt, identity: { ...receipt.identity, heartbeatRunId: other.attempts[0].heartbeatId } } },
    { payload: { ...receipt, identity: { ...receipt.identity, wakeupRequestId: w.attempts[1].wakeId } } },
    { payload: { ...receipt, identity: { ...receipt.identity, workflow: { ...receipt.identity.workflow!, retryCount: 99 } } } },
  ];
  for (const mutation of mutations) await expect(db.transaction(async tx => {
    await tx.update(agentWakeupRequests).set(mutation).where(eq(agentWakeupRequests.id, receipt.id));
    await lockCurrentScope(tx as unknown as Db, w.agentId);
  })).rejects.toThrow();
  await expect(pause(db, { ...input(w), companyId: other.companyId })).rejects.toThrow();
  await expect(pause(db, { ...input(w), heartbeatRunIds: [other.attempts[0].heartbeatId] })).rejects.toThrow();
  // A second correctly marked head is corruption, not permission to choose whichever was newest.
  await expect(db.transaction(async tx => {
    const id = randomUUID();
    await tx.insert(agentWakeupRequests).values({ ...PAUSE_CONTROL_COLUMNS, id, companyId: w.companyId, agentId: w.agentId,
      payload: { ...saved.head, id } });
    await lockCurrentScope(tx as unknown as Db, w.agentId);
  })).rejects.toThrow();
  expect((await controls(peer, w.agentId)).map(readPauseControl).filter(p => p.kind === "receipt")).toHaveLength(2);
});
