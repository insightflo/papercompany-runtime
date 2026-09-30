import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agentWakeupRequests, heartbeatRuns, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { lifecycleActiveClause } from "../services/heartbeat-finalization/lifecycle-active.js";

it.each([false, true])("normal issue-only wake -> real claim -> official register/select, finalization=%s", async enabled => {
  await flag(enabled); const f = await fixture(), db = database(); adapter.mockReset();
  let observed: typeof heartbeatRuns.$inferSelect | undefined, wake: typeof agentWakeupRequests.$inferSelect | undefined;
  let productId: string | undefined, error: unknown;
  adapter.mockImplementation(async ({ runId }: { runId: string }) => {
    try {
      observed = await f.readRun(runId);
      [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, observed.wakeupRequestId!));
      productId = (await f.register(runId))!.id;
      // Selection requires completion; only this downstream fixture state is explicitly set.
      await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
      expect((await f.select()).product.id).toBe(productId);
    } catch (e) { error = e; }
    return stopped;
  });
  await f.wake(); await drain();
  expect(adapter).toHaveBeenCalledTimes(1); expect(error).toBeUndefined();
  expect(wake).toMatchObject({ workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7 });
  expect(observed).toMatchObject({ status: "running", workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7,
    finalizationVersion: enabled ? 1 : 0 });
  if (!enabled) {
    expect(observed).toMatchObject({ executionToken: null, executionEpoch: null, executorOwnerLeaseToken: null, settledAt: null });
    expect(await f.readStep()).toMatchObject({ dispatchOwnerHeartbeatRunId: null, dispatchOwnerWakeupRequestId: null, dispatchReadyAt: null });
  } else expect(observed?.executorOwnerLeaseToken).toEqual(expect.any(String));
});
it.each(["generation", "company", "agent", "issue", "run", "step", "coalesced"])("claim rejects original wake %s mismatch atomically", async mismatch => {
  await flag(false); adapter.mockReset(); const f = await fixture(), db = database();
  const { run, request } = await f.queued(), other = await fixture();
  const patch = mismatch === "generation" ? { workflowExecutionGeneration: 6 }
    : mismatch === "company" ? { companyId: other.companyId }
    : mismatch === "agent" ? { agentId: other.agentId }
    : mismatch === "issue" ? { issueId: other.issueId }
    : mismatch === "run" ? { workflowRunId: other.workflowRunId }
    : mismatch === "step" ? { workflowStepRunId: other.stepRunId } : { runId: randomUUID(), status: "coalesced" };
  await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, request.id));
  await expect(claimHeartbeatWithRecoveryGuard(db, run, new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", startedAt: null, workflowStepRunId: null, executionToken: null });
  expect(adapter).not.toHaveBeenCalled();
});
it("claim does not upgrade an old accepted generation after a step reset", async () => {
  await flag(false); const f = await fixture(), db = database(), { run } = await f.queued();
  await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(claimHeartbeatWithRecoveryGuard(db, run, new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", workflowExecutionGeneration: null });
});
it.each(["foreign-company", "wrong-issue"])("new explicit step wake rejects %s rather than selecting a mismatched link", async kind => {
  await flag(false); const f = await fixture(), other = await fixture(), db = database(); adapter.mockReset(); adapter.mockResolvedValue(stopped);
  if (kind === "wrong-issue") await db.update(workflowStepRuns).set({ issueId: other.issueId }).where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(f.wake({ workflowStepRunId: kind === "foreign-company" ? other.stepRunId : f.stepRunId })).rejects.toThrow(/heartbeat_workflow/);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toEqual([]);
  expect(adapter).not.toHaveBeenCalled();
});
it("issue-only wake cannot silently drop identity when an explicit same-company run is wrong", async () => {
  await flag(false); const f = await fixture(), db = database(); adapter.mockReset().mockResolvedValue(stopped);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.workflowRunId));
  const [other] = await db.insert(workflowRuns).values({ companyId: f.companyId, workflowId: run.workflowId, status: "running", triggeredBy: "test" }).returning();
  await expect(f.wake({ workflowRunId: other.id })).rejects.toThrow(/heartbeat_workflow/);
  expect(adapter).not.toHaveBeenCalled();
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toEqual([]);
});
it("legacy NULL wake is not retroactively typed; nonworkflow claim and OFF capacity are unchanged", async () => {
  await flag(false); const f = await fixture(), db = database();
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
    issueId: f.issueId, source: "automation" }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
    status: "queued", wakeupRequestId: wake.id }).returning();
  const claimed = await claimHeartbeatWithRecoveryGuard(db, run, new Date());
  expect(claimed).toMatchObject({ status: "running", workflowStepRunId: null, workflowExecutionGeneration: null, finalizationVersion: 0 });
  expect((await f.register(run.id))?.metadata.workflowProducer).toBeUndefined();
  for (let n = 0; n < 2; n++) await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
    status: "failed", finalizationVersion: 1, settledAt: null, errorCode: "process_lost" });
  const clause = await lifecycleActiveClause(db);
  const [{ n }] = await db.select({ n: count() }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId), clause));
  expect(Number(n)).toBe(1);
});
