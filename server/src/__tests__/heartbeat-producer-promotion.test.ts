import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowStepRuns } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";

it.each([false, true])("paused explicit-step wake promotion retains original identity, stale=%s", async stale => {
  await flag(false); const f = await fixture(), db = database(); adapter.mockReset().mockResolvedValue(stopped);
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
  await f.wake({ workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId });
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
  expect(wake).toMatchObject({ runId: null, status: "queued", workflowExecutionGeneration: 7, workflowStepRunId: f.stepRunId });
  if (stale) await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
  await heartbeatService(db).resumeQueuedRuns(f.agentId); await drain();
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
  if (stale) {
    expect(adapter).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: "cancelled", startedAt: null, workflowExecutionGeneration: null });
  } else {
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7, finalizationVersion: 0 });
    expect((await f.register(run.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: run.id });
  }
});
it.each([false, true])("deferred issue execution promotion retains original identity, stale=%s", async stale => {
  await flag(false); const f = await fixture(), db = database(); adapter.mockReset().mockResolvedValue(stopped);
  const [owner] = await db.insert(agents).values({ companyId: f.companyId, name: "Different owner", status: "paused" }).returning();
  const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: owner.id, issueId: f.issueId,
    status: "running", contextSnapshot: { issueId: f.issueId } }).returning();
  await db.update(issues).set({ executionRunId: busy.id, executionAgentNameKey: "different-owner", executionLockedAt: new Date() })
    .where(eq(issues.id, f.issueId));
  await f.wake();
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
  expect(wake).toMatchObject({ status: "deferred_issue_execution", workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7 });
  if (stale) await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await heartbeatService(db).cancelRun(busy.id); await drain();
  const [child] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
  if (stale) { expect(adapter).not.toHaveBeenCalled(); expect(child).toMatchObject({ status: "cancelled", startedAt: null }); }
  else {
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(child).toMatchObject({ workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7, finalizationVersion: 0 });
    expect((await f.register(child.id))?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: child.id });
  }
});
it("later coalesced wake cannot upgrade the original queued wake after generation reset", async () => {
  await flag(false); const f = await fixture(), db = database(), { run, request } = await f.queued(); adapter.mockReset();
  await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await f.wake(); await drain();
  const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
  expect(wakes.find(wake => wake.id !== request.id)).toMatchObject({ status: "coalesced", workflowExecutionGeneration: 8, runId: run.id });
  expect((await f.readRun(run.id)).wakeupRequestId).toBe(request.id);
  await expect(claimHeartbeatWithRecoveryGuard(db, await f.readRun(run.id), new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(adapter).not.toHaveBeenCalled();
});
it("claim refuses a supplied heartbeat whose original wake binding changed in the DB", async () => {
  await flag(false); const f = await fixture(), db = database(), { run } = await f.queued();
  const [replacementWake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
    issueId: f.issueId, source: "automation", runId: run.id }).returning();
  await db.update(heartbeatRuns).set({ wakeupRequestId: replacementWake.id }).where(eq(heartbeatRuns.id, run.id));
  await expect(claimHeartbeatWithRecoveryGuard(db, run, new Date())).rejects.toThrow(/heartbeat_workflow/);
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", workflowStepRunId: null });
});
it("claim transaction rolls back status and identity if the DB write fails", async () => {
  await flag(false); const f = await fixture(), db = database(), { run } = await f.queued();
  await expect(db.transaction(async tx => {
    await claimHeartbeatWithRecoveryGuard(tx as unknown as typeof db, run, new Date());
    throw new Error("simulated transaction failure");
  })).rejects.toThrow("simulated transaction failure");
  expect(await f.readRun(run.id)).toMatchObject({ status: "queued", startedAt: null, workflowStepRunId: null, workflowExecutionGeneration: null });
});
