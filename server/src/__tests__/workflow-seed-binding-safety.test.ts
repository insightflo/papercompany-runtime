import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { createDb, workflowStepRuns, workflowRuns, workflowStepOutputBindings, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { pinWorkProductForStep } from "../services/workflow/workflow-output-binding.js";
import { applyStructuralGatePass } from "../services/workflow/control-flow/structural-gate-rework.js";
import { lockProducerSelection } from "../services/work-products/producer-selection-lock.js";
import { resetStepRunForRework } from "../services/workflow/control-flow/step-reset.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("seed-binding-safety-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "seed-binding-safety-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
async function world() {
  const f = await seedWorld(db, root), target = await f.admit();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, target.id));
  await ensureWorkflowStepRunRecords(db, { runId: target.id, steps: f.steps, buildMetadata: () => ({}), syncControls: async (_db, rows) => rows });
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const producer = rows.find(s => s.stepId === "write")!, consumer = rows.find(s => s.stepId === "use")!;
  const input = { db, run: target, step: f.steps[1], workflowSteps: f.steps, consumerStepRunId: consumer.id };
  await resolveWorkflowToolStepArgs(input);
  const pin = { companyId: f.companyId, workflowRunId: target.id, consumerStepRunId: consumer.id,
    referencedStepId: "write", workProductId: f.product.id };
  return { f, target, producer, consumer, input, pin };
}
it("manual producer counter and consumer reset never authorize pin retirement", async () => {
  const w = await world();
  await db.update(workflowStepRuns).set({ iterationIndex: 1, status: "completed" }).where(eq(workflowStepRuns.id, w.producer.id));
  await db.update(workflowStepRuns).set({ status: "failed", lastDispatchRequestId: "old-request" }).where(eq(workflowStepRuns.id, w.consumer.id));
  const steps = [w.f.steps[0], { ...w.f.steps[1], type: "tool", agentId: "", toolNames: ["check"], qaType: "structural" as const }];
  await applyStructuralGatePass({ db, run: w.target, steps,
    stepRuns: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, w.target.id)) });
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.consumer.id)))[0].status).toBe("pending");
  expect((await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, w.consumer.id)))[0].workProductId).toBe(w.f.product.id);
  await expect(resolveWorkflowToolStepArgs(w.input)).rejects.toThrow();
  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, w.f.companyId),
    eq(activityLog.action, "workflow.output_binding_retired")))).toHaveLength(0);
});
it("stale native reset cannot consume another iteration or overwrite newer state", async () => {
  const w = await world();
  await resetStepRunForRework({ db, companyId: w.f.companyId, stepRun: w.producer });
  await expect(resetStepRunForRework({ db, companyId: w.f.companyId, stepRun: w.producer })).rejects.toThrow();
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producer.id)))[0].iterationIndex).toBe(1);
});
it("concurrent pin writer waits for attempt reset then rejects the old seed", async () => {
  const w = await world();
  let locked!: () => void, release!: () => void;
  const acquired = new Promise<void>(r => { locked = r; }), gate = new Promise<void>(r => { release = r; });
  const reset = db.transaction(async tx => {
    await lockProducerSelection(tx, { companyId: w.f.companyId, workflowRunId: w.target.id,
      stepRunIds: [w.producer.id, w.consumer.id] }, "update");
    await tx.update(workflowStepRuns).set({ iterationIndex: 1, status: "pending" }).where(eq(workflowStepRuns.id, w.producer.id));
    locked(); await gate;
  });
  await acquired;
  let settled = false;
  const writer = pinWorkProductForStep(db, w.pin).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await new Promise(r => setTimeout(r, 100));
  const waited = !settled;
  release(); await reset;
  const outcome = await writer;
  expect(waited).toBe(true);
  expect(outcome).toHaveProperty("error");
});
