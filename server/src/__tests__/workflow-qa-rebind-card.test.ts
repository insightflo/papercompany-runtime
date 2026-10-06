import { createHash } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import * as languageHelper from "../services/missions/system-language.js";
import { activityLog, agentWakeupRequests, companies, instanceSettings, issueWorkProducts, missions,
  operatorDecisionContinuations, operatorDecisions, workflowQaRebindClaims, workflowRecoveryAuthorities,
  workflowRuns, workflowStepRuns, workflowTerminalDecisions } from "@paperclipai/db";
import { qaRebindFixture } from "./helpers/qa-rebind-fixture.js";
import { sweepQaRebindCandidates } from "../services/workflow/qa-rebind-candidate.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";

afterAll(() => setWorkflowToolStepExecutor(null));
async function seed(cascade = false, sweep = true) {
  const f = await qaRebindFixture();
  setWorkflowToolStepExecutor(async () => ({ accepted: true }));
  await f.db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.companyId, f.companyId));
  await f.db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  await f.db.update(workflowStepRuns).set({ status: cascade ? "skipped" : "pending",
    ...(cascade ? { metadata: { failureCascadeSkipped: true } } : {}) }).where(eq(workflowStepRuns.id, f.verifyId));
  // A temporarily unproven producer requires human review without changing the pinned byte target.
  if (!cascade) await f.db.update(workflowStepRuns).set({ status: "pending" }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  await f.db.insert(workflowTerminalDecisions).values({ companyId: f.companyId, workflowRunId: f.runId,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler", recoveryGate: {} });
  await f.db.insert(instanceSettings).values({ singletonKey: "default", experimental: {} })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: {} } });
  await f.persist();
  if (sweep) await sweepQaRebindCandidates(f.db);
  await f.db.update(workflowStepRuns).set({ status: "completed" }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  const [candidate] = await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, f.companyId));
  return { ...f, candidate };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function cards(f: Fixture) {
  return f.db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, f.companyId)).orderBy(operatorDecisions.createdAt);
}
async function execution(f: Fixture) {
  return { run: await f.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId)),
    steps: await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId)).orderBy(workflowStepRuns.id),
    products: await f.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, f.companyId)),
    authorities: await f.db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, f.companyId)) };
}
async function resolve(f: Fixture, option: string) {
  const [card] = await cards(f); expect(card).toBeDefined();
  await operatorDecisionWriteService(f.db).resolve(card.id, { actionId: "submit", selectedOptionIds: [option], comment: null }, "test-board");
  return card;
}
async function claim(f: Fixture) {
  return (await f.db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.id, f.candidate.id)))[0];
}

// Breaks caught: language-dependent key/hash conflicts, linked-task wakeups, duplicate
// claims, stale approval admission, cascade approval and fuzzy terminal cleanup.
it("T13: flag-off card creation and sequential language change replay the stored row", async () => {
  const f = await seed(); const [before] = await cards(f);
  expect(before).toBeDefined();
  expect(before).toMatchObject({ sourceType: "workflow_qa_rebind", issueId: null, continuationMode: "none", interactionType: "single_select" });
  expect(before.definition.options.map(o => o.id)).toEqual(["approve", "dismiss"]);
  await f.db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, f.companyId));
  await sweepQaRebindCandidates(f.db);
  expect(await cards(f)).toEqual([before]);
  const created = await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "operator_decision.created")));
  expect(created).toHaveLength(1);
});

it("T13: concurrent first requests with different languages replay the winning stored card", async () => {
  const f = await seed(false, false);
  await f.db.update(workflowQaRebindClaims).set({ status: "card_required" }).where(eq(workflowQaRebindClaims.id, f.candidate.id));
  const { ensureQaRebindCard } = await import("../services/workflow/qa-rebind-card.js");
  // Only the display-language lookup is doubled; all card/claim state uses real PG.
  const language = vi.spyOn(languageHelper, "loadCompanySystemLanguage").mockResolvedValueOnce("en").mockResolvedValueOnce("ko");
  let results: Awaited<ReturnType<typeof ensureQaRebindCard>>[];
  try { results = await Promise.all([ensureQaRebindCard(f.db, f.companyId, f.candidate.id), ensureQaRebindCard(f.db, f.companyId, f.candidate.id)]); }
  finally { language.mockRestore(); }
  const stored = await cards(f); expect(stored).toHaveLength(1);
  expect(results.map(r => r?.decision.id)).toEqual([stored[0].id, stored[0].id]);
  expect(results.map(r => r?.replayed).sort()).toEqual([false, true]);
  expect(results[0]?.decision).toEqual(results[1]?.decision);
  expect(await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "operator_decision.created")))).toHaveLength(1);
});

it("T14: dismiss through the real route closes the candidate with zero wakeups/continuations", async () => {
  const f = await seed(), [card] = await cards(f); expect(card).toBeDefined();
  const before = await execution(f);
  const wakes = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "test-board" }; next(); });
  app.use(operatorDecisionRoutes(f.db));
  const server = createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/operator-decisions/${card.id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: "submit", selectedOptionIds: ["dismiss"], comment: null }),
    });
    expect(response.status).toBe(200);
  } finally { await new Promise<void>(r => server.close(() => r())); }
  await sweepQaRebindCandidates(f.db); await sweepQaRebindCandidates(f.db);
  expect((await claim(f)).status).toBe("dismissed"); expect(await execution(f)).toEqual(before);
  expect(await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(wakes);
  expect(await f.db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, f.companyId))).toHaveLength(0);
  expect(await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "workflow.qa_rebind_dismissed")))).toHaveLength(1);
});

it("T15: approve uses strict recovery exactly once even with the B flag off", async () => {
  const f = await seed(); await resolve(f, "approve");
  await Promise.all([sweepQaRebindCandidates(f.db), sweepQaRebindCandidates(f.db)]);
  const after = await execution(f), c = await claim(f);
  expect(c.status).toBe("recovered"); expect(after.authorities).toHaveLength(1);
  expect(after.authorities[0]).toMatchObject({ recoveryKind: "supervision_tool_retry", id: c.authorityId });
  expect(after.steps.find(s => s.id === f.publishId)).toMatchObject({ executionGeneration: 1, status: "running",
    metadata: { toolQueue: { status: "queued" } } });
  await sweepQaRebindCandidates(f.db); expect(await execution(f)).toEqual(after);
  expect(await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "workflow.qa_rebind_recovered")))).toHaveLength(1);
});

it("T16: cascade-skipped run has a notice and only dismiss, never approve", async () => {
  const f = await seed(true), [card] = await cards(f); expect(card).toBeDefined();
  expect(card.definition.options.map(o => o.id)).toEqual(["dismiss"]);
  expect(card.definition.humanReview?.unresolvedFacts.length).toBeGreaterThan(0);
  await expect(operatorDecisionWriteService(f.db).resolve(card.id,
    { actionId: "submit", selectedOptionIds: ["approve"], comment: null }, "test-board")).rejects.toThrow();
  expect((await execution(f)).authorities).toHaveLength(0);
});

it.each(["cascade", "generation", "authority", "digest"])("approve-time %s change records target_changed once without execution", async variant => {
  const f = await seed(); await resolve(f, "approve");
  if (variant === "cascade") await f.db.update(workflowStepRuns).set({ status: "skipped", metadata: { failureCascadeSkipped: true } }).where(eq(workflowStepRuns.id, f.verifyId));
  if (variant === "generation") await f.db.update(workflowStepRuns).set({ executionGeneration: 9 }).where(eq(workflowStepRuns.id, f.publishId));
  if (variant === "authority") await f.db.update(workflowRuns).set({ dispatchAuthorityVersion: 9 }).where(eq(workflowRuns.id, f.runId));
  if (variant === "digest") {
    const [qa] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
    const receipt = qa.metadata.toolArtifactReceipt as any;
    await f.patchQa({ ...qa.metadata, toolArtifactReceipt: { ...receipt, input: { ...receipt.input, byteSize: receipt.input.byteSize + 1 } } });
  }
  const before = await execution(f);
  await sweepQaRebindCandidates(f.db); await sweepQaRebindCandidates(f.db);
  expect(await execution(f)).toEqual(before); expect((await claim(f)).claimedAt).toBeNull();
  expect(await f.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "workflow.qa_rebind_target_changed")))).toHaveLength(1);
});

it.each(["completed", "cancelled"])("%s cleanup cancels only exact stored request keys, preserving lookalike cards", async terminal => {
  const f = await seed(), [card] = await cards(f); expect(card).toBeDefined();
  await f.db.insert(operatorDecisions).values({ ...card, id: undefined, requestKey: `${card.requestKey}x` });
  await f.db.update(workflowRuns).set({ status: terminal }).where(eq(workflowRuns.id, f.runId));
  await sweepQaRebindCandidates(f.db);
  expect(Object.fromEntries((await cards(f)).map(c => [c.requestKey, c.status]))).toEqual({ [card.requestKey]: "cancelled", [`${card.requestKey}x`]: "pending" });
});

it("card write failure is savepoint-isolated from an authoritative caller transaction", async () => {
  const f = await seed(), [card] = await cards(f);
  await f.db.delete(operatorDecisions).where(eq(operatorDecisions.id, card.id));
  await f.db.execute(sql`CREATE FUNCTION qa_card_audit_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action = 'operator_decision.created' THEN RAISE EXCEPTION 'test card audit rejected'; END IF; RETURN NEW; END $$`);
  await f.db.execute(sql`CREATE TRIGGER qa_card_audit_reject BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION qa_card_audit_reject()`);
  try {
    const { ensureQaRebindCard } = await import("../services/workflow/qa-rebind-card.js");
    await f.db.transaction(async tx => {
      await tx.select().from(missions).where(eq(missions.id, f.missionId)).for("update");
      await tx.update(workflowRuns).set({ metadata: { savepointCallerCommitted: true } }).where(eq(workflowRuns.id, f.runId));
      expect(await ensureQaRebindCard(tx as any, f.companyId, f.candidate.id)).toBeNull();
    });
    expect((await execution(f)).run[0].metadata).toEqual({ savepointCallerCommitted: true });
    expect(await cards(f)).toHaveLength(0);
  } finally {
    await f.db.execute(sql`DROP TRIGGER qa_card_audit_reject ON activity_log`);
    await f.db.execute(sql`DROP FUNCTION qa_card_audit_reject()`);
  }
});

it("a target_changed approval stays retired even if its old generation returns", async () => {
  const f = await seed(); await resolve(f, "approve");
  await f.db.update(workflowStepRuns).set({ executionGeneration: 9 }).where(eq(workflowStepRuns.id, f.publishId));
  await sweepQaRebindCandidates(f.db);
  expect(await cards(f)).toHaveLength(2);
  await f.db.update(workflowStepRuns).set({ executionGeneration: 0 }).where(eq(workflowStepRuns.id, f.publishId));
  const before = await execution(f);
  await sweepQaRebindCandidates(f.db); expect(await execution(f)).toEqual(before);
  expect((await claim(f)).claimedAt).toBeNull();
});

it("unversioned or foreign audit prose cannot retire a resolved approve decision", async () => {
  const f = await seed(), card = await resolve(f, "approve");
  await f.db.insert(activityLog).values({ companyId: f.companyId, actorType: "user", actorId: "test-board",
    action: "workflow.qa_rebind_target_changed", entityType: "operator_decision", entityId: card.id,
    details: { outcome: "target_changed", comment: "do not retry" } });
  await sweepQaRebindCandidates(f.db);
  expect((await claim(f)).status).toBe("recovered"); expect((await execution(f)).authorities).toHaveLength(1);
});

it("approval target uses only the canonical expected digests, authority and generation", async () => {
  const f = await seed(), [card] = await cards(f); expect(card).toBeDefined();
  const c = await claim(f), d = c.expectedDigests as { sha256: string; byteSize: number };
  const json = JSON.stringify({ authorityVersion: c.authorityVersion, executionGeneration: c.executionGeneration,
    expectedDigests: { bundleDigest: c.bundleDigest, byteSize: d.byteSize, sha256: d.sha256 } });
  const hash = createHash("sha256").update(json).digest("hex");
  expect(card.requestKey).toBe(`qrb1:${f.runId}:publisher:${hash}`);
  expect(card.sourceId).toBe(`qrb1:${c.id}:${hash}`);
});
