import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { heartbeatRuns, workflowStepRuns } from "@paperclipai/db";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { issueService } from "../services/issues.js";
import { workProductService } from "../services/work-products.js";

it("initial native DAG issue creation admits typed identity before the first adapter starts", async () => {
  await flag(false); const f = await fixture(), db = database();
  await db.update(workflowStepRuns).set({ issueId: null, status: "pending", startedAt: null }).where(eq(workflowStepRuns.id, f.stepRunId));
  let observed: typeof heartbeatRuns.$inferSelect | undefined, error: unknown; adapter.mockReset();
  adapter.mockImplementation(async ({ runId }: { runId: string }) => {
    observed = await f.readRun(runId);
    try {
      await issueService(db).checkout(observed.issueId!, f.agentId, ["todo", "in_progress"], runId);
      await syncWorkflowRunState(db, f.workflowRunId);
      const step = await f.readStep();
      console.info("native admission timing", { heartbeatStartedAt: observed.startedAt, stepStartedAt: step.startedAt,
        workflowStepRunId: observed.workflowStepRunId, generation: observed.workflowExecutionGeneration,
        retryCount: step.retryCount, iterationIndex: step.iterationIndex });
      const product = await workProductService(db).createForIssue(observed.issueId!, f.companyId, {
        provider: "custom", type: "document", title: "content.json", status: "active", createdByRunId: runId });
      expect(product?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: runId });
    } catch (e) { error = e; }
    return stopped;
  });
  await syncWorkflowRunState(db, f.workflowRunId); await drain();
  expect(adapter).toHaveBeenCalledTimes(1); expect(error).toBeUndefined();
  expect(observed).toMatchObject({ workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7, finalizationVersion: 0 });
});
