import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agentWakeupRequests, workflowStepRuns } from "@paperclipai/db";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { resetStepRunForRework } from "../services/workflow/control-flow/step-reset.js";
import { enqueueAdapterFallbackRun } from "../services/heartbeat-retry-enqueue.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";

it("the admission writer rejects a foreign-company agent before inserting an original proof", async () => {
  await flag(false); const f = await fixture(), other = await fixture(), db = database();
  await expect(insertWorkflowWakeRequest(db, { companyId: f.companyId, agentId: other.agentId, issueId: f.issueId,
    workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7,
    source: "automation", status: "queued" })).rejects.toThrow(/heartbeat_workflow/);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, other.agentId))).length).toBe(0);
});

it("a typed ON fallback admission is not execution until its own atomic claim", async () => {
  await flag(true); const f = await fixture(), db = database(), { run } = await f.queued();
  const parent = (await claimHeartbeatWithRecoveryGuard(db, run, new Date()))!;
  const child = await enqueueAdapterFallbackRun({ db, resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} },
    parent, f.agent, new Date(), { fallbackCommand: "test-never-executed", fallbackReason: "test" });
  expect(child).toMatchObject({ status: "queued", startedAt: null, workflowStepRunId: f.stepRunId });
  await expect(f.register(child.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
  await claimHeartbeatWithRecoveryGuard(db, child, new Date());
  expect((await f.register(child.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: child.id });
});

// Catches generation-only claims adopting a queued original request after an OFF rework reset.
it.each([false, true])("claim refuses the original attempt after same-generation rework, finalization=%s", async enabled => {
  await flag(false); const f = await fixture(), db = database(), { run } = await f.queued();
  await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
  expect(await f.readStep()).toMatchObject({ executionGeneration: 7, iterationIndex: 1 });
  await flag(enabled);
  await expect(claimHeartbeatWithRecoveryGuard(db, run, new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", startedAt: null, workflowStepRunId: null });
});

// Catches a reserved proof supplied by an API caller surviving server admission unchanged.
it("inbound reserved proof is replaced at original admission, never trusted from context", async () => {
  await flag(false); const f = await fixture(), db = database(); let id = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { id = runId; return stopped; });
  await f.wake({ __paperclipWorkflowProducerAttempt: { schemaVersion: 1, retryCount: 999, iterationIndex: 999 } });
  await drain();
  expect((await f.register(id))?.metadata.workflowProducer).toMatchObject({ retryCount: 0, iterationIndex: 0 });
  const run = await f.readRun(id);
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
  expect(wake.payload?.__paperclipWorkflowProducerAttempt).toMatchObject({ schemaVersion: 1, retryCount: 0, iterationIndex: 0,
    wakeupRequestId: wake.id, companyId: f.companyId, agentId: f.agentId, workflowRunId: f.workflowRunId, stepRunId: f.stepRunId });
});

// Catches typed historical/malformed records borrowing current counters at claim.
it.each(["missing", "malformed", "unknown-version", "foreign-scope"])("typed %s proof fails closed before claim", async kind => {
  await flag(false); const f = await fixture(), db = database(), { run, request } = await f.queued();
  const payload = { ...request.payload };
  if (kind === "missing") delete payload.__paperclipWorkflowProducerAttempt;
  else payload.__paperclipWorkflowProducerAttempt = kind === "malformed" ? []
    : { ...(payload.__paperclipWorkflowProducerAttempt as object), ...(kind === "unknown-version" ? { schemaVersion: 2 } : { issueId: null }) };
  await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, request.id));
  await expect(claimHeartbeatWithRecoveryGuard(db, run, new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", startedAt: null, workflowStepRunId: null });
});

// Catches later coalesced context relabeling an original attempt with the same generation.
it("later coalesced wake cannot prove an earlier queued attempt after OFF rework", async () => {
  await flag(false); const f = await fixture(), db = database(), { run, request } = await f.queued();
  await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
  await f.wake({ __paperclipWorkflowProducerAttempt: { iterationIndex: 1 } }); await drain();
  const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
  expect(wakes.find(w => w.id !== request.id)).toMatchObject({ status: "coalesced", workflowExecutionGeneration: 7 });
  expect((await f.readRun(run.id)).wakeupRequestId).toBe(request.id);
  await expect(claimHeartbeatWithRecoveryGuard(db, await f.readRun(run.id), new Date())).rejects.toThrow(/heartbeat_workflow/);
});

// Catches the timestamp heuristic accepting the old producer once a current attempt is running.
it("same-generation rework rejects old registration and selection despite overlapping start times", async () => {
  await flag(false); const f = await fixture(), db = database(); let id = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { id = runId; return stopped; });
  await f.wake(); await drain(); const old = await f.readRun(id); await f.register(id);
  await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
  // A display timestamp is deliberately not a new attempt's identity.
  await db.update(workflowStepRuns).set({ status: "completed", startedAt: new Date(old.startedAt!.getTime() - 1) })
    .where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(f.register(id)).rejects.toThrow("workproduct_producer_attempt_unproven");
  await expect(f.select()).rejects.toThrow(/workproduct_selector/);
});
