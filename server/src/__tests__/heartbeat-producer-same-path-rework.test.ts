import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { issues, issueWorkProducts, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { workProductService } from "../services/work-products.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { resetStepRunForRework } from "../services/workflow/control-flow/step-reset.js";
import { registerWorkflowArtifact } from "../services/workflow/agent-api.js";

// Break caught: a QA rework that edits the artifact in place re-registers the SAME path.
// The existing row must be re-stamped with the rework attempt, otherwise selection fails as stale.
it("same-path re-registration by the rework heartbeat re-stamps producer provenance", async () => {
  await flag(false); const f = await fixture(), db = database(), products = workProductService(db);
  await db.update(workflowStepRuns).set({ issueId: null, status: "pending", startedAt: null }).where(eq(workflowStepRuns.id, f.stepRunId));
  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const register = async (runId: string) => registerWorkflowArtifact({ db, issue: await readIssue((await f.readRun(runId)).issueId!),
    actor: { actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId },
    data: { path: f.file, type: "document" } });
  const ids: string[] = [], productIds: string[] = []; let error: unknown;
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => {
    try {
      ids.push(runId); const run = await f.readRun(runId);
      await issueService(db).checkout(run.issueId!, f.agentId, ["todo", "in_progress"], runId);
      await syncWorkflowRunState(db, f.workflowRunId);
      productIds.push((await register(runId)).id);
    } catch (e) { error = e; }
    return stopped;
  });
  await syncWorkflowRunState(db, f.workflowRunId); await drain(); expect(error).toBeUndefined(); expect(ids).toHaveLength(1);
  const issueId = (await f.readStep()).issueId!;
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  expect((await f.select()).product.id).toBe(productIds[0]);
  await resetStepRunForRework({ db, stepRun: await f.readStep(), companyId: f.companyId });
  expect(await f.readStep()).toMatchObject({ iterationIndex: 1 });
  // The iteration-0 heartbeat can no longer prove the current attempt, even for its own row.
  await expect(register(ids[0])).rejects.toThrow("workproduct_producer_attempt_unproven");
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.workflowRunId));
  await syncWorkflowRunState(db, f.workflowRunId); await drain();
  expect(error).toBeUndefined(); expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]);
  expect(productIds[1]).toBe(productIds[0]);
  const latest = await products.getById(productIds[0]);
  expect(latest).toMatchObject({ createdByRunId: ids[1] });
  const [stored] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, productIds[0]));
  expect(stored).toMatchObject({ createdByRunId: ids[1], sourceExecutionGeneration: 7 });
  expect(latest?.metadata).toMatchObject({ path: f.file, registeredVia: "workflow_api", registeredByRunId: ids[1],
    workflowProducer: { heartbeatRunId: ids[1], executionGeneration: 7, retryCount: 0, iterationIndex: 1 } });
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  expect((await f.select()).product.id).toBe(productIds[0]);
});
