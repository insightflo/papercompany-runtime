import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issues, workflowStepRuns } from "@paperclipai/db";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";
import { resetStepRunForRework } from "../services/workflow/control-flow/step-reset.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "../services/workflow/retry-launch-dispatch.js";

async function start(f: Awaited<ReturnType<typeof fixture>>, retry = false) {
  const db = database(); let id = ""; adapter.mockReset();
  adapter.mockImplementation(async ({ runId }: { runId: string }) => {
    id = runId;
    await issueService(db).checkout(f.issueId, f.agentId, ["todo", "in_progress"], runId);
    await syncWorkflowRunState(db, f.workflowRunId);
    return stopped;
  });
  // Native checkout, not a fixture's earlier start, projects the attempt's display timestamp.
  await db.update(workflowStepRuns).set({ status: "pending", startedAt: null }).where(eq(workflowStepRuns.id, f.stepRunId));
  await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
  if (retry) {
    const step = await f.readStep();
    await wakeIssueBackedRetryAndMarkDispatching({ db, companyId: f.companyId, workflowRunId: f.workflowRunId,
      definition: {}, run: {}, step: {}, stepRunId: f.stepRunId, stepRunMetadata: step.metadata,
      issueId: f.issueId, observedRetryCount: step.retryCount, resumeExistingIssue: false,
      wakeExistingWorkflowStepIssue: async input => { await f.wake({}, input.idempotencyKey!); return true; } });
  } else await f.wake();
  await drain(); expect(adapter).toHaveBeenCalledTimes(1);
  return f.readRun(id);
}
async function enqueue(f: Awaited<ReturnType<typeof fixture>>, run: typeof heartbeatRuns.$inferSelect, fallback: boolean) {
  const deps = { db: database(), resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} };
  return fallback ? enqueueAdapterFallbackRun(deps, run, f.agent, new Date(), { fallbackCommand: "test-never-executed", fallbackReason: "test" })
    : enqueueProcessLossRetry(deps, run, f.agent, new Date());
}
it.each([false, true].flatMap(fallback => [0, 1].map(retryCount => ({ fallback, retryCount }))))(
  "OFF retry descendant: fallback=$fallback retryCount=$retryCount after QA iteration", async ({ fallback, retryCount }) => {
    await flag(false); const f = await fixture(), db = database(), old = await start(f);
    await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
    await expect(f.register(old.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
    if (retryCount) {
      await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowStepRuns.id, f.stepRunId));
      const step = await f.readStep();
      expect((await scheduleWorkflowStepRetry(db, { companyId: f.companyId, workflowRunId: f.workflowRunId, stepRunId: f.stepRunId,
        retryNumber: 1, maxRetries: 2, delaySeconds: 0, observedStatus: step.status, observedRetryCount: step.retryCount,
        observedCompletedAt: step.completedAt, observedLastDispatchRequestId: step.lastDispatchRequestId,
        observedMetadataSnapshot: step.metadata!, observedExecutionGeneration: step.executionGeneration, errorSummary: "test" })).result).toBe("scheduled");
    }
    const parent = await start(f, Boolean(retryCount)), queued = await enqueue(f, parent, fallback);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId!));
    expect(wake).toMatchObject({ workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7, idempotencyKey: null });
    let error: unknown; adapter.mockReset();
    adapter.mockImplementation(async ({ runId }: { runId: string }) => {
      try {
        expect(runId).toBe(queued.id);
        expect(await f.readRun(runId)).toMatchObject({ finalizationVersion: 0, executionToken: null,
          workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7 });
        const product = await f.register(runId);
        expect(product?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: runId, retryCount, iterationIndex: 1 });
        await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
        expect((await f.select()).product.id).toBe(product!.id);
      } catch (e) { error = e; }
      return stopped;
    });
    await heartbeatService(db).resumeQueuedRuns(f.agentId); await drain();
    expect(adapter).toHaveBeenCalledTimes(1); expect(error).toBeUndefined();
    await expect(f.register(old.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
    expect(await f.readRun(parent.id)).toEqual(parent); // OFF must not transfer leases/epochs.
  });
it.each([false, true])("refuses stale typed parent before child insert, fallback=%s", async fallback => {
  await flag(false); const f = await fixture(), db = database(), parent = await start(f);
  await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(enqueue(f, parent, fallback)).rejects.toThrow(/heartbeat_workflow/);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, parent.id))).toEqual([]);
});
it("preserves finalization ON owner transfer and child claim", async () => {
  await flag(true); const f = await fixture(), { run } = await f.queued();
  const parent = (await claimHeartbeatWithRecoveryGuard(database(), run, new Date()))!;
  const queued = await enqueue(f, parent, true), child = (await claimHeartbeatWithRecoveryGuard(database(), queued, new Date()))!;
  expect(await f.readRun(parent.id)).toMatchObject({ executionEpoch: 1, executorOwnerLeaseEpoch: 2 });
  expect(child).toMatchObject({ finalizationVersion: 1, executionEpoch: 0, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7 });
  expect(child.executorOwnerLeaseToken).toEqual(expect.any(String));
  expect(await f.readStep()).toMatchObject({ dispatchOwnerHeartbeatRunId: child.id, dispatchOwnerWakeupRequestId: child.wakeupRequestId });
  expect((await f.register(child.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: child.id });
});
it("never adopts legacy parent identity from current issue/context", async () => {
  await flag(false); const f = await fixture(), db = database();
  const [parent] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
    status: "failed", contextSnapshot: { workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId } }).returning();
  const queued = await enqueue(f, parent, false), child = await claimHeartbeatWithRecoveryGuard(db, queued, new Date());
  expect(child).toMatchObject({ workflowStepRunId: null, workflowExecutionGeneration: null });
  expect((await f.register(child!.id))?.metadata.workflowProducer).toBeUndefined();
});
it.each(["foreign", "cycle", "missing", "old-iteration", "forged-key"])("rejects %s ancestor instead of borrowing retry proof", async kind => {
  await flag(false); const f = await fixture(), db = database(), parent = await start(f);
  const queued = await enqueue(f, parent, false), child = await claimHeartbeatWithRecoveryGuard(db, queued, new Date());
  if (kind === "forged-key") await db.update(agentWakeupRequests).set({ idempotencyKey: `workflow-step-retry:${f.stepRunId}:1` })
    .where(eq(agentWakeupRequests.id, child!.wakeupRequestId!));
  else if (kind === "old-iteration") await db.update(heartbeatRuns).set({ startedAt: new Date(0) }).where(eq(heartbeatRuns.id, parent.id));
  else if (kind === "missing") await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, parent.id));
  else {
    const foreign = kind === "foreign" ? await start(await fixture()) : null;
    await db.update(heartbeatRuns).set({ retryOfRunId: kind === "cycle" ? child!.id : foreign!.id }).where(eq(heartbeatRuns.id, child!.id));
  }
  await expect(f.register(child!.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
});
