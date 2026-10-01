import "./helpers/workflow-control-node-boundary.js";
import express from "express";
import request from "supertest";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, missions, workflowRuns, workflowDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { ensureOwnerPlanWorkflowRun } from "../services/workflow/owner-plan-workflow-run.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-board-start-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-board-start-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
it("automatic revision PLAN materialization leaves a definition for explicit board trigger", async () => {
  const f = await seedWorld(db, root);
  expect(await ensureOwnerPlanWorkflowRun({ db, companyId: f.companyId, missionId: f.revision.id, workflowId: f.definition.id,
    triggeredBy: f.agentId, requirePlanQaPass: async () => {} })).toBeNull();
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  const target = await f.admit();
  expect(await ensureOwnerPlanWorkflowRun({ db, companyId: f.companyId, missionId: f.revision.id, workflowId: f.definition.id,
    triggeredBy: f.agentId, requirePlanQaPass: async () => {} })).toBe(target.id);
});
it.each(["omitted", "different"])("HTTP rejects %s mission identity before any mission or run creation", async mode => {
  const f = await seedWorld(db, root);
  await db.update(workflowDefinitions).set({ sourceKind: "paqo", missionId: f.revision.id }).where(eq(workflowDefinitions.id, f.definition.id));
  const [ordinary] = await db.insert(missions).values({ companyId: f.companyId, ownerAgentId: f.agentId, title: "Ordinary" }).returning();
  const beforeMissions = await db.select().from(missions).where(eq(missions.companyId, f.companyId));
  const beforeRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "agent", agentId: f.agentId, companyId: f.companyId }; next(); });
  app.use("/api", workflowRoutes(db)); app.use(errorHandler);
  const response = await request(app).post(`/api/workflows/${f.definition.id}/runs`)
    .send(mode === "omitted" ? {} : { missionId: ordinary.id });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error).toBe("workflow_revision_mission_mismatch");
  expect(await db.select().from(missions).where(eq(missions.companyId, f.companyId))).toEqual(beforeMissions);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId))).toEqual(beforeRuns);
});
it("agent cannot bypass revision PLAN board wait by omitting seeds", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowDefinitions).set({ sourceKind: "paqo", missionId: f.revision.id }).where(eq(workflowDefinitions.id, f.definition.id));
  const { seedFromRun: _, ...input } = f.input;
  await expect(createAdmittedWorkflowRun(db, input, { type: "agent", agentId: f.agentId, companyId: f.companyId }))
    .rejects.toThrow("workflow_revision_board_start_required");
});
