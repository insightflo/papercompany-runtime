import { and, eq, sql } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, instanceSettings, issueWorkProducts, missions, workflowQaRebindClaims,
  workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { qaRebindFixture } from "./helpers/qa-rebind-fixture.js";
import { sweepQaRebindCandidates } from "../services/workflow/qa-rebind-candidate.js";
import { retryIssueLessToolWorkflowStepInternal } from "../services/workflow/retry-issue-less-manual.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";
import { rebindProducerProvenance } from "../services/workflow/producer-provenance-rebind.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

afterAll(() => setWorkflowToolStepExecutor(null));
async function seed() {
  const f = await qaRebindFixture(), { db } = f;
  // Explicit non-executing adapter boundary. Native sync still writes the real durable queue.
  setWorkflowToolStepExecutor(async () => ({ accepted: true }));
  // Admission fixture proves producer identity but leaves wake lifecycle claimed; recovery requires quiescence.
  await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.companyId, f.companyId));
  await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, f.verifyId));
  await db.insert(workflowTerminalDecisions).values({ companyId: f.companyId, workflowRunId: f.runId,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler", recoveryGate: {} });
  await flag(f, false); await f.persist(); await sweepQaRebindCandidates(db);
  const [candidate] = await db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId));
  expect(candidate.status).toBe("auto_eligible");
  return { ...f, candidate };
}
async function flag(f: Awaited<ReturnType<typeof qaRebindFixture>>, enabled: boolean) {
  await f.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableQaRebindRecoveryV1: enabled } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableQaRebindRecoveryV1: enabled } } });
}
async function snapshot(f: Awaited<ReturnType<typeof seed>>) {
  const { db, companyId, runId } = f;
  return { run: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
    steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id),
    products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
    claims: await db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, companyId)),
    authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, companyId)),
    events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)),
    activities: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)) };
}
function retry(f: Awaited<ReturnType<typeof seed>>, sync = async () => ({ status: "running" }) as never) {
  const c = f.candidate;
  return retryIssueLessToolWorkflowStepInternal({ db: f.db, companyId: f.companyId, runId: f.runId, stepId: "publisher",
    recoveryRequestReference: `qa-rebind:${c.id}`,
    expectedFailure: { stepRunId: f.publishId, authorityVersion: c.authorityVersion,
      executionGeneration: c.executionGeneration, dispatchRequestId: c.requestId },
    qaRebind: { candidateId: c.id, bundleDigest: c.bundleDigest, authorityVersion: c.authorityVersion, executionGeneration: c.executionGeneration },
    loadWorkflowExecutionContext, isIssueLessToolStep: () => true, resetUnlaunchedTerminalStepRuns: async () => [],
    syncWorkflowRunState: sync,
  } as Parameters<typeof retryIssueLessToolWorkflowStepInternal>[0]);
}
function rebind(f: Awaited<ReturnType<typeof seed>>, expected?: { sha256: string; byteSize: number }) {
  return rebindProducerProvenance(f.db, { companyId: f.companyId, workflowRunId: f.runId, producerStepId: "write",
    productId: f.receipt.input.workProductId, actor: { actorType: "board", actorId: "test-board" }, expected } as any);
}

// Breaks caught: claiming before denial, committing rejected authority, duplicate recovery,
// mismatched marker acceptance, disabled-flag dispatch, and run→mission lock inversion.
it.each(["mission_cancelled", "stale_generation", "missing_decision"])("T2: %s leaves no claim or rebind writes", async variant => {
  const f = await seed();
  if (variant === "mission_cancelled") await f.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.missionId));
  if (variant === "stale_generation") await f.db.update(workflowStepRuns).set({ executionGeneration: 7 }).where(eq(workflowStepRuns.id, f.publishId));
  if (variant === "missing_decision") await f.db.delete(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, f.companyId));
  const before = await snapshot(f); expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});

it("T3: recoverTerminalRun rejection rolls back claim, rebind, authority and reset", async () => {
  const f = await seed();
  const [decision] = await f.db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, f.companyId));
  await f.db.insert(workflowRecoveryAuthorities).values({ companyId: f.companyId, workflowRunId: f.runId,
    targetAuthorityVersion: 0, resultingAuthorityVersion: 1, targetDecisionId: decision.id,
    recoveryKind: "supervision_tool_retry", requestReference: "already-consumed", requestedBy: "test" });
  const before = await snapshot(f);
  // Sequence increments survive rollback: prove the rejection happened AFTER attempted claim, not at an earlier guard.
  await f.db.execute(sql`CREATE SEQUENCE qa_rebind_claim_attempts`);
  await f.db.execute(sql`CREATE FUNCTION qa_rebind_count_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status = 'claimed' THEN PERFORM nextval('qa_rebind_claim_attempts'); END IF; RETURN NEW; END $$`);
  await f.db.execute(sql`CREATE TRIGGER qa_rebind_count_claim BEFORE UPDATE ON workflow_qa_rebind_claims
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_count_claim()`);
  try {
    expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
    const [counter] = await f.db.execute(sql`SELECT last_value, is_called FROM qa_rebind_claim_attempts`);
    expect(counter).toMatchObject({ last_value: "1", is_called: true });
  } finally {
    await f.db.execute(sql`DROP TRIGGER qa_rebind_count_claim ON workflow_qa_rebind_claims`);
    await f.db.execute(sql`DROP FUNCTION qa_rebind_count_claim()`);
    await f.db.execute(sql`DROP SEQUENCE qa_rebind_claim_attempts`);
  }
});

it("T4: concurrent and repeated candidate processing consumes exactly one conditional claim", async () => {
  const f = await seed();
  expect((await Promise.all([retry(f), retry(f)])).filter(Boolean)).toHaveLength(1);
  const after = await snapshot(f);
  expect(after.claims[0]).toMatchObject({ status: "recovered", authorityId: after.authorities[0].id });
  expect(after.authorities).toHaveLength(1); expect(after.authorities[0].recoveryKind).toBe("supervision_tool_retry");
  expect(after.steps.find(s => s.id === f.publishId)).toMatchObject({ status: "pending", executionGeneration: 1 });
  expect(after.steps.find(s => s.id === f.verifyId)).toMatchObject({ status: "pending", lastDispatchRequestId: "inspector" });
  expect(after.activities.filter(a => a.action === "workflow.qa_rebind_recovered")).toHaveLength(1);
  expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(after);
  // A new failed authority/attempt with the SAME bundle must not replace the permanent claim key.
  await f.db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.runId));
  await f.db.update(workflowStepRuns).set({ status: "failed", lastDispatchRequestId: "publisher-next" })
    .where(eq(workflowStepRuns.id, f.publishId));
  await f.db.insert(workflowTerminalDecisions).values({ companyId: f.companyId, workflowRunId: f.runId,
    decidedAuthorityVersion: 1, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler", recoveryGate: {} });
  expect(await f.persist()).toBeNull();
  const repeated = await snapshot(f); await flag(f, true); await sweepQaRebindCandidates(f.db);
  expect(await snapshot(f)).toEqual(repeated);
});

it("T11: flag off sweeps classify only, even when repeated", async () => {
  const f = await seed(), before = await snapshot(f);
  await sweepQaRebindCandidates(f.db); expect(await snapshot(f)).toEqual(before);
  expect(before.claims[0].claimedAt).toBeNull(); expect(before.authorities).toHaveLength(0);
});

it("flag on sweeps reuse the DAG wrapper and persist one accepted recovery", async () => {
  const f = await seed(); await flag(f, true);
  await sweepQaRebindCandidates(f.db);
  const after = await snapshot(f);
  expect(after.claims[0].status).toBe("recovered"); expect(after.authorities).toHaveLength(1);
  expect(after.steps.find(s => s.id === f.publishId)).toMatchObject({ status: "running", metadata: { toolQueue: { status: "queued" } } });
  expect(after.steps.find(s => s.id === f.publishId)?.lastDispatchRequestId).toEqual(expect.any(String));
  await sweepQaRebindCandidates(f.db);
  expect((await snapshot(f)).authorities).toEqual(after.authorities);
});

it("T12: already_rebound with a different expected SHA rejects without writes; board replay stays unchanged", async () => {
  const f = await seed(); await rebind(f);
  const before = await snapshot(f);
  await expect(rebind(f, { sha256: "0".repeat(64), byteSize: f.receipt.input.byteSize })).rejects.toThrow("producer_rebind_bytes_changed");
  expect(await snapshot(f)).toEqual(before);
  await expect(rebind(f)).resolves.toMatchObject({ status: "already_rebound" });
});

it("T1: rebind waits for mission before locking run, allowing concurrent strict recovery to serialize", async () => {
  const f = await seed();
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { ready = r; });
  const holder = f.db.transaction(async tx => {
    await tx.select().from(missions).where(eq(missions.id, f.missionId)).for("update");
    ready(); await gate;
    // NOWAIT detects the historical run→mission cycle without hanging the suite.
    await tx.execute(sql`SELECT id FROM workflow_runs WHERE id = ${f.runId} AND company_id = ${f.companyId} FOR UPDATE NOWAIT`);
  });
  await locked;
  const board = rebind(f).catch(error => error);
  const recovery = retry(f);
  await new Promise(r => setTimeout(r, 150)); release();
  const [held, boardResult, recovered] = await Promise.all([holder.catch(error => error), board, recovery]);
  expect(held).toBeUndefined();
  expect(recovered).not.toBeNull();
  if (boardResult instanceof Error) expect(boardResult.message).toBe("producer_rebind_run_not_failed");
  else expect(["rebound", "already_rebound"]).toContain(boardResult.status);
  expect((await snapshot(f)).authorities).toHaveLength(1);
});

it("T4: conditional claim returning zero rolls back the preceding rebind and performs no recovery", async () => {
  const f = await seed(), before = await snapshot(f);
  await f.db.execute(sql`CREATE FUNCTION qa_rebind_lose_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status = 'claimed' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await f.db.execute(sql`CREATE TRIGGER qa_rebind_lose_claim BEFORE UPDATE ON workflow_qa_rebind_claims
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_lose_claim()`);
  try { expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(before); }
  finally {
    await f.db.execute(sql`DROP TRIGGER qa_rebind_lose_claim ON workflow_qa_rebind_claims`);
    await f.db.execute(sql`DROP FUNCTION qa_rebind_lose_claim()`);
  }
});

it("reset failure propagates and rolls back claim, marker, authority and generation", async () => {
  const f = await seed(), before = await snapshot(f);
  await f.db.execute(sql`CREATE FUNCTION qa_rebind_reset_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.step_id = 'publisher' AND NEW.status = 'pending' THEN RAISE EXCEPTION 'test reset rejected'; END IF; RETURN NEW; END $$`);
  await f.db.execute(sql`CREATE TRIGGER qa_rebind_reset_reject BEFORE UPDATE ON workflow_step_runs
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_reset_reject()`);
  try { await expect(retry(f)).rejects.toThrow("test reset rejected"); expect(await snapshot(f)).toEqual(before); }
  finally {
    await f.db.execute(sql`DROP TRIGGER qa_rebind_reset_reject ON workflow_step_runs`);
    await f.db.execute(sql`DROP FUNCTION qa_rebind_reset_reject()`);
  }
});

it("changed original bytes at first rebind reject without claiming or reopening", async () => {
  const f = await seed(); await writeFile(f.content, "changed after classification");
  const before = await snapshot(f);
  await expect(retry(f)).rejects.toThrow("producer_rebind_bytes_changed"); expect(await snapshot(f)).toEqual(before);
});

it("new cascade skips are revalidated under recovery locks and never claimed", async () => {
  const f = await seed();
  await f.db.update(workflowStepRuns).set({ status: "skipped", metadata: { failureCascadeSkipped: true } })
    .where(eq(workflowStepRuns.id, f.verifyId));
  const before = await snapshot(f); expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});

it("missing flag defaults off; company allowlist recovers only the opted-in company", async () => {
  const f = await seed(), other = await seed();
  await f.db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
  const before = await snapshot(f); await sweepQaRebindCandidates(f.db); expect(await snapshot(f)).toEqual(before);
  await f.db.insert(instanceSettings).values({ singletonKey: "default",
    experimental: { enableQaRebindRecoveryCompanyIdsV1: [f.companyId] } });
  await sweepQaRebindCandidates(f.db);
  expect((await snapshot(f)).claims[0].status).toBe("recovered");
  expect((await snapshot(other)).claims[0].status).toBe("auto_eligible");
});

it("delivery crash leaves one recovered claim and the durable accepted receipt for reconciliation", async () => {
  const f = await seed();
  // Failure at the existing postcommit sync boundary, not a DB reset failure inside acceptance.
  await expect(retry(f, async () => { throw new Error("test delivery crash"); })).rejects.toThrow("test delivery crash");
  const after = await snapshot(f);
  expect(after.claims[0].status).toBe("recovered"); expect(after.authorities).toHaveLength(1);
  expect(after.steps.find(s => s.id === f.publishId)).toMatchObject({ status: "pending", metadata: {
    ownerToolRetry: { authorityId: after.authorities[0].id, authorityVersion: 1, executionGeneration: 1 } } });
  expect(await retry(f)).toBeNull(); expect(await snapshot(f)).toEqual(after);
});
