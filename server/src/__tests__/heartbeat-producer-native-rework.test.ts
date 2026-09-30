import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { workProductService } from "../services/work-products.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { resetStepRunForRework } from "../services/workflow/control-flow/step-reset.js";

// Break caught: the real next native wake must prove iteration 1 while the original heartbeat stays iteration 0.
it("native creation and post-claim checkout register/select both original and OFF same-generation rework", async () => {
  await flag(false); const f = await fixture(), db = database(), products = workProductService(db);
  await db.update(workflowStepRuns).set({ issueId: null, status: "pending", startedAt: null }).where(eq(workflowStepRuns.id, f.stepRunId));
  const ids: string[] = [], productIds: string[] = []; let error: unknown;
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => {
    try {
      ids.push(runId); const run = await f.readRun(runId);
      await issueService(db).checkout(run.issueId!, f.agentId, ["todo", "in_progress"], runId);
      await syncWorkflowRunState(db, f.workflowRunId);
      const product = await products.createForIssue(run.issueId!, f.companyId, { provider: "local_file", type: "document",
        title: "content.json", status: "active", isPrimary: false, createdByRunId: runId, metadata: { path: f.file } });
      productIds.push(product!.id);
    } catch (e) { error = e; }
    return stopped;
  });
  await syncWorkflowRunState(db, f.workflowRunId); await drain(); expect(error).toBeUndefined(); expect(ids).toHaveLength(1);
  // The QA success/rework facts are fixture preconditions; queue/admission/checkout/register are real services.
  const issueId = (await f.readStep()).issueId!;
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  expect((await f.select()).product.id).toBe(productIds[0]);
  await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
  expect(await f.readStep()).toMatchObject({ executionGeneration: 7, retryCount: 0, iterationIndex: 1 });
  await expect(products.createForIssue(issueId, f.companyId, { provider: "custom", type: "document", title: "old.json",
    status: "active", createdByRunId: ids[0] })).rejects.toThrow("workproduct_producer_attempt_unproven");
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
  await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, f.stepRunId));
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.workflowRunId));
  await syncWorkflowRunState(db, f.workflowRunId); await drain();
  expect(error).toBeUndefined(); expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]);
  const latest = await products.getById(productIds[1]);
  expect(latest?.metadata.workflowProducer).toMatchObject({ heartbeatRunId: ids[1], executionGeneration: 7, retryCount: 0, iterationIndex: 1 });
  // Explicit test archival preserves strict exact-one selection; runtime never auto-replaces old output.
  await products.update(productIds[0], { status: "archived" });
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  expect((await f.select()).product.id).toBe(productIds[1]);
});
