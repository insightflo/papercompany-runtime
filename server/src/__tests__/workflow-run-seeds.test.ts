import "./helpers/workflow-control-node-boundary.js";
import express from "express";
import request from "supertest";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowRuns, workflowStepRuns, workflowDefinitions, workflowRunSeeds, activityLog, missions, issues } from "@paperclipai/db";
import { triggerWorkflowRunSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("workflow-seeds-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflow-seeds-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
// Removing durable seed admission/materialization makes the native engine dispatch Write instead of Use.
it("shared board trigger accepts an explicit seed set", () => {
  expect(triggerWorkflowRunSchema.safeParse({ seedFromRun: { sourceWorkflowRunId: randomUUID(), stepIds: ["write"] } }).success).toBe(true);
});
it("materializes approved source completion and delivers its original product to downstream", async () => {
  const f = await seedWorld(db, root), target = await f.admit();
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id))).toEqual([]);
  const [approval] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(approval).toMatchObject({ approvedByUserId: "local-board", sourceRunId: f.sourceRun.id, sourceStepRunId: f.sourceStep.id });
  expect((await db.select().from(activityLog).where(eq(activityLog.entityId, target.id))).map(a => a.action)).toContain("workflow_run.seed_approved");
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write")).toMatchObject({ status: "completed", issueId: null, startedAt: null, lastDispatchAttemptAt: null });
  const use = rows.find(s => s.stepId === "use")!;
  expect(use.issueId).toBeTruthy();
  const [downstreamIssue] = await db.select().from(issues).where(eq(issues.id, use.issueId!));
  expect(downstreamIssue.description).toContain(f.file);
  const selected = await selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id, stepId: "write",
    selector: { type: "document", title: "content.json" } });
  expect(selected.product.id).toBe(f.product.id);
  expect(selected.producer.workflowRunId).toBe(f.sourceRun.id);
  expect(await resolveWorkflowToolStepArgs({ db, run: target, step: f.steps[1], workflowSteps: f.steps, consumerStepRunId: use.id }))
    .toEqual({ content: f.file });
  await writeFile(f.file, "tampered");
  await expect(selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id, stepId: "write",
    selector: { type: "document", title: "content.json" } })).rejects.toThrow("workflow_seed");
});
it.each(["sha", "incomplete", "definition", "scope", "foreign", "dag", "unsupported"])("rejects %s before durable target creation", async reason => {
  const f = await seedWorld(db, root);
  if (reason === "sha") await writeFile(f.file, "changed");
  if (reason === "incomplete") await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  if (reason === "definition") await db.update(workflowDefinitions).set({ stepsJson: [{ ...f.steps[0], toolArgs: { changed: true } }, f.steps[1]] }).where(eq(workflowDefinitions.id, f.definition.id));
  if (reason === "scope") await db.update(missions).set({ sourceWorkflowRunId: null }).where(eq(missions.id, f.revision.id));
  if (reason === "foreign") f.input.seedFromRun.sourceWorkflowRunId = (await seedWorld(db, root)).sourceRun.id;
  if (reason === "dag") f.input.seedFromRun.stepIds = ["use"];
  if (reason === "unsupported") await db.update(workflowDefinitions).set({ stepsJson: [{ ...f.steps[0], type: "workflow" }, f.steps[1]] }).where(eq(workflowDefinitions.id, f.definition.id));
  await expect(f.admit()).rejects.toThrow(reason === "sha" ? "workflow_seed_sha_mismatch" : "workflow_seed");
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, f.companyId))).toEqual([]);
});
it("cannot impersonate board via triggeredBy or caller metadata", async () => {
  const f = await seedWorld(db, root);
  for (const actor of [undefined, { type: "agent" as const, agentId: f.agentId, companyId: f.companyId }]) {
    await expect(createAdmittedWorkflowRun(db, { ...f.input, metadata: { approvedBy: "local-board", seedFromRun: f.input.seedFromRun } }, actor))
      .rejects.toThrow("workflow_seed_board_required");
  }
});
it("revalidates files at materialization and refuses all step inserts after mutation", async () => {
  const f = await seedWorld(db, root), target = await f.admit();
  await writeFile(f.file, "changed after approval");
  await expect(executeWorkflowRun(db, target.id)).rejects.toThrow("workflow_seed_sha_mismatch");
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id))).toEqual([]);
});
it("seed consumption without an explicit selector cannot fall back to metadata", async () => {
  const f = await seedWorld(db, root), target = await f.admit();
  await executeWorkflowRun(db, target.id);
  await expect(resolveWorkflowToolStepArgs({ db, run: target,
    step: { id: "use", dependencies: ["write"], toolArgs: { content: "{$steps.write.workProductPath}" } }, workflowSteps: f.steps }))
    .rejects.toThrow("workflow_seed_explicit_selector_required");
});
it("board HTTP trigger passes seed admission while an agent spoofing triggeredBy is rejected", async () => {
  const f = await seedWorld(db, root);
  const app = express(); app.use(express.json());
  let actor: Express.Request["actor"] = { type: "agent", agentId: f.agentId, companyId: f.companyId };
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", workflowRoutes(db)); app.use(errorHandler);
  const payload = { missionId: f.revision.id, seedFromRun: f.input.seedFromRun, triggeredBy: "board" };
  const denied = await request(app).post(`/api/workflows/${f.definition.id}/runs`).send(payload);
  expect(denied.status).toBe(403);
  expect(denied.body.error).toBe("workflow_seed_board_required");
  actor = board;
  const accepted = await request(app).post(`/api/workflows/${f.definition.id}/runs`).send(payload);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, accepted.body.runId));
  expect(rows.find(s => s.stepId === "write")).toMatchObject({ status: "completed", issueId: null });
});
it("no seed retains ordinary initial materialization", async () => {
  const f = await seedWorld(db, root);
  const { seedFromRun: _, ...input } = f.input;
  const target = await createAdmittedWorkflowRun(db, input, board);
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write")?.issueId).toBeTruthy();
  expect(rows.find(s => s.stepId === "use")).toMatchObject({ status: "pending", issueId: null });
});
