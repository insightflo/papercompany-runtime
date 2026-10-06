import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agentWakeupRequests, operatorDecisions, workflowRecoveryAuthorities,
  missions, workflowRuns, workflowStepRuns, workflowQaRebindClaims } from "@paperclipai/db";
import { artifactDagFixture } from "./helpers/artifact-dag-fixture.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";
import { classifyQaRebindCandidate, persistQaRebindCandidate, sweepQaRebindCandidates } from "../services/workflow/qa-rebind-candidate.js";
import { rebindProducerProvenance } from "../services/workflow/producer-provenance-rebind.js";
import { processQueuedWorkflowToolStepRuns } from "../services/workflow/dag-engine.js";
import { persistFailedToolDispatch } from "../services/workflow/tool-dispatch-failure.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";

// Breaks caught: original/frozen confusion, missing negative evidence fences,
// lost failure candidates, duplicate audit writes, and accidental execution mutation.
async function fixture() {
  const f = await artifactDagFixture(true), { db } = f;
  await db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 } })
    .where(eq(workflowRuns.id, f.runId));
  await db.transaction(tx => captureExecutionDefinition(tx, f.runId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const qaResult = await f.invoke(); expect(qaResult.status).toBe(200);
  await f.complete("qa", qaResult);
  const receipt = qaResult.toolArtifactReceipt!;
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  const parameters = await f.resolve("publisher");
  await db.update(workflowStepRuns).set({ status: "failed", metadata: {
    ...(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId)))[0].metadata,
    toolInvocation: { requestId: "publisher", args: parameters, dispatchError: "workproduct_selector_stale_producer" },
  } }).where(eq(workflowStepRuns.id, f.publishId));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.runId));
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, f.missionId));
  const scope = { companyId: f.companyId, workflowRunId: f.runId, consumerStepRunId: f.publishId };
  const classify = () => classifyQaRebindCandidate(db, scope);
  const persist = () => persistQaRebindCandidate(db, scope);
  const patchQa = (metadata: Record<string, unknown>) => db.update(workflowStepRuns).set({ metadata })
    .where(eq(workflowStepRuns.id, f.qaId));
  return { ...f, receipt, qa, parameters, scope, classify, persist, patchQa };
}

it("T5: classification uses frozen QA copies, not a changed unmarked original", async () => {
  const f = await fixture();
  const before = await f.classify(); expect(before).toMatchObject({ status: "auto_eligible", reasonCode: "generation_only" });
  await writeFile(f.content, "original changed; minor/경미 is not authority");
  expect(await f.classify()).toEqual(before);
});

it("T5: an existing rebind marker still fences changed original bytes before frozen consumption", async () => {
  const f = await fixture();
  await f.db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  await rebindProducerProvenance(f.db, { companyId: f.companyId, workflowRunId: f.runId,
    producerStepId: "write", productId: f.receipt.input.workProductId,
    actor: { actorType: "board", actorId: "test-board" } });
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const consumer = { db: f.db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: f.publishId,
    stepId: "publisher", requestId: "publisher", parameters: f.parameters };
  await f.db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.publishId));
  await writeFile(f.content, "changed after rebind");
  await expect(prepareQaConsumer(consumer)).rejects.toThrow("workproduct_selector_rebind_bytes_mismatch");
  expect(await f.classify()).toMatchObject({ status: "blocked", reasonCode: "producer_bytes_mismatch" });
});

it.each(["input", "asset", "result"])("T6: changed frozen %s digest is blocked", async kind => {
  const f = await fixture();
  const file = kind === "input" ? `input/${path.basename(f.content)}`
    : kind === "asset" ? "input/assets/hero.png" : f.receipt.relativePath;
  const target = path.join(f.receipt.outputRoot, file);
  await chmod(target, 0o600); await writeFile(target, "tampered");
  expect(await f.classify()).toMatchObject({ status: "blocked", reasonCode: "frozen_digest_mismatch" });
});

it("T7: v1 receipt without a contract hash requires a card, never automatic eligibility", async () => {
  const f = await fixture();
  const { contractHash: _, qaConfigHash: __, runtimeChecks: ___, pluginChecks: ____, ...legacy } = f.receipt as any;
  await f.patchQa({ ...f.qa.metadata, toolArtifactReceipt: { ...legacy, schemaVersion: "workflow.tool-artifact.v1" } });
  expect(await f.classify()).toMatchObject({ status: "card_required", reasonCode: "receipt_v1_no_contract_hash" });
});

it.each(["companyId", "missionId", "workflowRunId"])("T8: foreign receipt %s is excluded", async field => {
  const f = await fixture();
  await f.patchQa({ ...f.qa.metadata, toolArtifactReceipt: { ...f.receipt, [field]: randomUUID() } });
  expect(await f.classify()).toMatchObject({ status: "excluded", reasonCode: "receipt_scope_mismatch" });
});

it("T9: publication-verify is blocked before receipt and cascade classification", async () => {
  const f = await fixture();
  await f.db.update(workflowStepRuns).set({ status: "failed", metadata: {
    ...(await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.verifyId)))[0].metadata,
    failureCascadeSkipped: true,
  } }).where(eq(workflowStepRuns.id, f.verifyId));
  expect(await classifyQaRebindCandidate(f.db, { ...f.scope, consumerStepRunId: f.verifyId }))
    .toMatchObject({ status: "blocked", reasonCode: "publication_unproven" });
});

it("T9: validated same-QA publication is not auto-eligible; digest/target mismatch is blocked first", async () => {
  const f = await fixture();
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await f.db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.publishId));
  const result = await f.execute("publisher"); expect(result.status).toBe(200);
  const [step] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  const setResult = (data: unknown) => f.db.update(workflowStepRuns).set({ status: "failed",
    metadata: { ...step.metadata, toolResult: { success: true, requestId: "publisher", data } } })
    .where(eq(workflowStepRuns.id, f.publishId));
  await setResult(result.body.data);
  expect(await f.classify()).toMatchObject({ status: "card_required", reasonCode: "published_same_qa" });
  const data = result.body.data as any;
  for (const changed of [{ ...data, inputDigest: { ...data.inputDigest, qaSha256: "0".repeat(64) } },
    { ...data, cms: { ...data.cms, contentId: "foreign-target" } }]) {
    await setResult(changed);
    expect(await f.classify()).toMatchObject({ status: "blocked", reasonCode: "publication_unproven" });
  }
});

it("dispatch failure persists a candidate without synchronous classification", async () => {
  const f = await fixture();
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await f.db.update(workflowStepRuns).set({ status: "running", lastDispatchAcceptedAt: null, lastDispatchErrorAt: null })
    .where(eq(workflowStepRuns.id, f.publishId));
  const result = await processQueuedWorkflowToolStepRuns(f.db);
  expect(result.failedCount).toBeGreaterThan(0);
  const rows = await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId));
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe("candidate");
  // Observation storage failure must not roll back the authoritative failed step.
  const other = await fixture();
  await other.db.execute(sql`CREATE FUNCTION qa_rebind_test_reject() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'observation unavailable'; END $$`);
  await other.db.execute(sql`CREATE TRIGGER qa_rebind_test_reject BEFORE INSERT ON workflow_qa_rebind_claims
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_test_reject()`);
  try {
    await other.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, other.runId));
    await other.db.update(workflowStepRuns).set({ status: "running", lastDispatchAcceptedAt: null, lastDispatchErrorAt: null })
      .where(eq(workflowStepRuns.id, other.publishId));
    await processQueuedWorkflowToolStepRuns(other.db);
    expect((await other.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, other.publishId)))[0].status).toBe("failed");
  } finally {
    await other.db.execute(sql`DROP TRIGGER qa_rebind_test_reject ON workflow_qa_rebind_claims`);
    await other.db.execute(sql`DROP FUNCTION qa_rebind_test_reject()`);
  }
});

it("T10: any same-run failureCascadeSkipped step requires a card, even issue-less", async () => {
  const f = await fixture();
  await f.db.update(workflowStepRuns).set({ metadata: { failureCascadeSkipped: true } })
    .where(eq(workflowStepRuns.id, f.verifyId));
  expect(await f.classify()).toMatchObject({ status: "card_required", reasonCode: "failure_cascade_skipped" });
});

it("sweep classifies once, audits once, and changes no run/step or execution state", async () => {
  const f = await fixture();
  await Promise.all([f.persist(), f.persist()]);
  const candidates = () => f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId));
  expect(await candidates()).toHaveLength(1); expect((await candidates())[0].status).toBe("candidate");
  const state = async () => ({
    runs: await f.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId)),
    steps: await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId)),
    authorities: await f.db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, f.companyId)),
    cards: await f.db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, f.companyId)),
    wakeups: await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
  });
  const before = await state();
  await Promise.all([sweepQaRebindCandidates(f.db), sweepQaRebindCandidates(f.db)]);
  await sweepQaRebindCandidates(f.db);
  expect(await state()).toEqual(before);
  expect((await candidates())[0]).toMatchObject({ status: "auto_eligible", reasonCode: "generation_only", authorityVersion: 0 });
  expect(await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
    eq(activityLog.action, "workflow.qa_rebind_classified")))).toHaveLength(1);
});

it("failed tool completion persists only a candidate; nonterminal run waits for sweep", async () => {
  const f = await fixture();
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await f.db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.publishId));
  await f.complete("publisher", { status: 500, body: { data: { ok: false } } } as any);
  const rows = await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId));
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe("candidate");
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await sweepQaRebindCandidates(f.db);
  expect((await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.id, rows[0].id)))[0].status).toBe("candidate");
});

it("NOTE: completion callback candidate INSERT failure preserves the authoritative failed write", async () => {
  const f = await fixture();
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await f.db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.publishId));
  await f.db.execute(sql`CREATE FUNCTION qa_rebind_callback_reject() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'callback observation unavailable'; END $$`);
  await f.db.execute(sql`CREATE TRIGGER qa_rebind_callback_reject BEFORE INSERT ON workflow_qa_rebind_claims
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_callback_reject()`);
  try {
    await f.complete("publisher", { status: 500, body: { data: { ok: false } } } as any);
    const [step] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
    expect(step.status).toBe("failed");
    expect(step.metadata.toolResult).toMatchObject({ success: false, requestId: "publisher" });
    expect(await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId))).toHaveLength(0);
  } finally {
    await f.db.execute(sql`DROP TRIGGER qa_rebind_callback_reject ON workflow_qa_rebind_claims`);
    await f.db.execute(sql`DROP FUNCTION qa_rebind_callback_reject()`);
  }
});

it("NOTE: consumer failure and finalizeRunTerminal serialize run before step without deadlock", async () => {
  const f = await fixture(), { db } = f;
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.publishId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>(r => { release = r; }), locked = new Promise<void>(r => { ready = r; });
  await db.execute(sql`CREATE FUNCTION qa_rebind_failure_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = ${sql.raw(`'${f.publishId}'`)}::uuid AND NEW.status = 'failed' THEN
      PERFORM pg_advisory_xact_lock(41230412); END IF; RETURN NEW; END $$`);
  await db.execute(sql`CREATE TRIGGER qa_rebind_failure_pause BEFORE UPDATE ON workflow_step_runs
    FOR EACH ROW EXECUTE FUNCTION qa_rebind_failure_pause()`);
  const holder = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(41230412)`); ready(); await gate;
  });
  await locked;
  const writer = persistFailedToolDispatch({ db, step: f.steps.find(s => s.id === "publisher")! as any,
    stepRun, now: new Date(), requestId: "publisher", toolName: "publisher", args: f.parameters,
    error: "workproduct_selector_stale_producer", provenance: { run, source: "workflow_retry" } }, stepRun.metadata);
  let terminal: ReturnType<typeof finalizeRunTerminal> | undefined;
  try {
    for (let n = 0; n < 100; n++) {
      const waiters = await db.execute(sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 41230412 AND NOT granted`);
      if (waiters.length) break;
      if (n === 99) throw new Error("failure writer did not reach pause");
      await new Promise(r => setTimeout(r, 10));
    }
    terminal = finalizeRunTerminal(db, { companyId: f.companyId, runId: f.runId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler" },
      gatePolicy: "immediate", now: new Date(), stepRuns: [stepRun] });
    await new Promise(r => setTimeout(r, 100)); release();
    const [, , finalized] = await Promise.all([holder, writer, terminal]);
    expect(finalized.kind).toBe("finalized");
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId)))[0].status).toBe("failed");
    expect(await db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId))).toHaveLength(1);
  } finally {
    release(); await Promise.allSettled([holder, writer, ...(terminal ? [terminal] : [])]);
    await db.execute(sql`DROP TRIGGER qa_rebind_failure_pause ON workflow_step_runs`);
    await db.execute(sql`DROP FUNCTION qa_rebind_failure_pause()`);
  }
}, 15000);
