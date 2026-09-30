import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { heartbeatRuns, workflowStepRuns } from "@paperclipai/db";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";

it("preserves two-hop transient-retry -> fallback ancestry and rejects the ancestor after iteration reset", async () => {
  await flag(false); const f = await fixture(), db = database(); let id = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { id = runId; return stopped; });
  await f.wake(); await drain(); const parent = await f.readRun(id);
  const deps = { db, resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} };
  const retry = await enqueueProcessLossRetry(deps, parent, f.agent, new Date(), { kind: "adapter_failed_transient" });
  const claimed = (await claimHeartbeatWithRecoveryGuard(db, retry, new Date()))!;
  const fallback = await enqueueAdapterFallbackRun(deps, claimed, f.agent, new Date(), { fallbackCommand: "test-double", fallbackReason: "test" });
  const child = (await claimHeartbeatWithRecoveryGuard(db, fallback, new Date()))!;
  expect((await f.register(child.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: child.id, retryCount: 0, iterationIndex: 0 });
  await db.update(workflowStepRuns).set({ iterationIndex: 1, startedAt: new Date(Date.now() + 1) }).where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(f.register(child.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
  await expect(enqueueProcessLossRetry(deps, child, f.agent, new Date())).rejects.toThrow("heartbeat_workflow_attempt_unproven");
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, child.id))).toEqual([]);
});
it("registration rejects an overlong typed ancestry without unbounded traversal", async () => {
  await flag(false); const f = await fixture(), db = database(); let id = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { id = runId; return stopped; });
  await f.wake(); await drain(); let parent = await f.readRun(id);
  const deps = { db, resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} };
  // Every supported ancestor has a real original proof and claim; missing proof cannot mask the limit.
  for (let n = 0; n < 31; n++) {
    const queued = await enqueueProcessLossRetry(deps, parent, f.agent, new Date());
    parent = (await claimHeartbeatWithRecoveryGuard(db, queued, new Date()))!;
  }
  expect((await f.register(parent.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: parent.id });
  const unsupported = await enqueueProcessLossRetry(deps, parent, f.agent, new Date());
  await expect(claimHeartbeatWithRecoveryGuard(db, unsupported, new Date())).rejects.toThrow("heartbeat_workflow_attempt_unproven");
  // Corrupt claimed-row fixture verifies registration still enforces the same bound independently.
  await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), workflowStepRunId: f.stepRunId,
    workflowExecutionGeneration: 7 }).where(eq(heartbeatRuns.id, unsupported.id));
  await expect(f.register(unsupported.id)).rejects.toThrow("workproduct_producer_attempt_unproven");
});
