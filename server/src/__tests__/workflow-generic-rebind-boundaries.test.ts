import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, heartbeatRuns, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { selectSameRunWorkProduct } from "../services/workflow/workproduct-same-run.js";
import { ProducerRebindRequired, withAutomaticProducerRebind } from "../services/workflow/automatic-producer-rebind.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { pinWorkProductForStep } from "../services/workflow/workflow-output-binding.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("generic-boundaries-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "generic-boundaries-")));
}, 60000);
afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it("never issues inside an unwrapped caller transaction or savepoint", async () => {
  const f = await genericProducerFixture(db, root);
  await expect(db.transaction(tx => tx.transaction(nested =>
    selectSameRunWorkProduct(nested as unknown as typeof db, f.scope)))).rejects.toBeInstanceOf(ProducerRebindRequired);
  expect(await f.events()).toEqual([]);
  expect((await f.read()).metadata!.workflowProducerRebind).toBeUndefined();
});
it("rolls back earlier consumer writes before root recovery, then reruns from fresh state", async () => {
  const f = await genericProducerFixture(db, root);
  let attempts = 0;
  await withAutomaticProducerRebind(db, () => db.transaction(async tx => {
    attempts++;
    const [consumer] = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.consumerId));
    expect(consumer.metadata).toEqual({});
    await tx.update(workflowStepRuns).set({ metadata: { committedAttempt: attempts } }).where(eq(workflowStepRuns.id, f.consumerId));
    await selectSameRunWorkProduct(tx as unknown as typeof db, f.scope);
  }));
  expect(attempts).toBe(2); expect(await f.events()).toHaveLength(1);
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.consumerId)))[0].metadata).toEqual({ committedAttempt: 2 });
});
it("concurrent transaction consumers share one marker and one frozen pin", async () => {
  const f = await genericProducerFixture(db, root);
  expect(await Promise.all([f.resolve(), f.resolve()])).toEqual([{ input: f.file }, { input: f.file }]);
  expect(await f.events()).toHaveLength(1); expect(await f.pins()).toHaveLength(1);
});
it("rechecks proof after waiting for the canonical run lock", async () => {
  const f = await genericProducerFixture(db, root);
  let started!: () => void, release!: () => void;
  const locked = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const holder = db.transaction(async tx => {
    await tx.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)).for("update");
    started(); await gate;
    await tx.update(heartbeatRuns).set({ workflowExecutionGeneration: 99 }).where(eq(heartbeatRuns.id, f.heartbeatId));
  });
  await locked;
  const consumer = f.select().then(value => ({ value }), error => ({ error }));
  try {
    // Wait for a real PostgreSQL lock waiter, not an assumed sleep duration.
    await expect.poll(async () => {
      const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%workflow_runs%'
        and pid <> pg_backend_pid()`);
      return Number(rows[0]?.n);
    }, { timeout: 5000 }).toBeGreaterThan(0);
  } finally { release(); await holder; }
  const outcome = await consumer;
  expect(outcome).toHaveProperty("error");
  if ("error" in outcome) expect(outcome.error).toMatchObject({ message: "workproduct_selector_stale_producer" });
  expect(await f.events()).toEqual([]);
});
it("preserves the mission-active guard instead of automatically bypassing it", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(f.admit()).rejects.toThrow("workproduct_selector_stale_producer");
  expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, f.sourceRun.id))).toEqual([]);
});
it("admits a seed after releasing target mission/source SHARE locks before issuance", async () => {
  const f = await seedWorld(db, root);
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, f.sourceMission.id));
  await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  const target = await f.admit(); expect(target.missionId).toBe(f.revision.id);
  const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, f.sourceRun.id));
  expect(events.filter(e => e.reason === "automatic_producer_provenance_rebind")).toHaveLength(1);
});
it("materializes and pins a seed after releasing target run locks before source issuance", async () => {
  const f = await seedWorld(db, root), target = await f.admit();
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, f.sourceMission.id));
  await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, target.id));
  const result = await ensureWorkflowStepRunRecords(db, { runId: target.id, steps: f.steps,
    buildMetadata: () => ({}), syncControls: async (_db, rows) => rows });
  expect(result.kind).toBe("ready");
  const consumer = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id)))
    .find(s => s.stepId === "use")!;
  await expect(pinWorkProductForStep(db, { companyId: f.companyId, workflowRunId: target.id,
    consumerStepRunId: consumer.id, referencedStepId: "write", workProductId: f.product.id })).resolves.toEqual({ kind: "pinned" });
});
