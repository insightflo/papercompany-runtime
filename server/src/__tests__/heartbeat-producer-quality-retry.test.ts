import { adapter, database, drain, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issues, missions, workflowStepRuns } from "@paperclipai/db";
import { qualityProducerFixture } from "./helpers/quality-producer-fixture.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "../services/workflow/retry-launch-dispatch.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";

it.each([false, true])("real quality retry wake -> descendant -> official register/select OFF, fallback=%s", async fallback => {
  const db = database(), dir = await mkdtemp(path.join(os.tmpdir(), "quality-lineage-")); await flag(false);
  const f = await qualityProducerFixture(db, dir), agentId = f.authorAgentId;
  try {
    await db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: dir, promptTemplate: "isolated callback" } })
      .where(eq(agents.id, agentId));
    expect((await f.schedule()).result).toBe("scheduled");
    let parentId = ""; adapter.mockReset();
    adapter.mockImplementation(async ({ runId }: { runId: string }) => {
      parentId = runId;
      await issueService(db).checkout(f.issueId, agentId, ["todo", "in_progress"], runId);
      await syncWorkflowRunState(db, f.workflowRunId);
      return stopped;
    });
    const step = await f.readStep();
    await wakeIssueBackedRetryAndMarkDispatching({ db, companyId: f.companyId, workflowRunId: f.workflowRunId,
      definition: {}, run: {}, step: {}, stepRunId: f.stepRunId, stepRunMetadata: step.metadata, issueId: f.issueId,
      observedRetryCount: step.retryCount, resumeExistingIssue: false, wakeExistingWorkflowStepIssue: async input => {
        const context = { issueId: f.issueId, workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, missionId: f.missionId };
        await heartbeatService(db).wakeup(agentId, { source: "automation", reason: "workflow_step_runnable", payload: context,
          contextSnapshot: context, idempotencyKey: input.idempotencyKey }); return true;
      } });
    await drain(); expect(adapter).toHaveBeenCalledTimes(1);
    const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, parentId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parent.wakeupRequestId!));
    expect(wake.qualityAcceptance).toMatchObject({ heartbeatRunId: parent.id, generation: 8 });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const deps = { db, resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} };
    const child = fallback ? await enqueueAdapterFallbackRun(deps, parent, agent, new Date(), { fallbackCommand: "test-double", fallbackReason: "test" })
      : await enqueueProcessLossRetry(deps, parent, agent, new Date());
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    let error: unknown; adapter.mockReset();
    adapter.mockImplementation(async ({ runId }: { runId: string }) => {
      try {
        expect(runId).toBe(child.id);
        const product = await f.register(runId);
        expect(product?.metadata.workflowProducer).toMatchObject({ retryCount: 1, executionGeneration: 8, heartbeatRunId: child.id });
        await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
        expect((await f.select()).product.id).toBe(product!.id);
      } catch (e) { error = e; }
      return stopped;
    });
    await heartbeatService(db).resumeQueuedRuns(agentId); await drain();
    expect(adapter).toHaveBeenCalledTimes(1); expect(error).toBeUndefined();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!)))[0])
      .toMatchObject({ idempotencyKey: null, qualityAcceptance: null });
  } finally {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.missionId));
    await drain(); await rm(dir, { recursive: true, force: true });
  }
});
