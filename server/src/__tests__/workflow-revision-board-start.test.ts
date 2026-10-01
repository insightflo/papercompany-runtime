import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowRuns, workflowDefinitions } from "@paperclipai/db";
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
it("agent cannot bypass revision PLAN board wait by omitting seeds", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowDefinitions).set({ sourceKind: "paqo", missionId: f.revision.id }).where(eq(workflowDefinitions.id, f.definition.id));
  const { seedFromRun: _, ...input } = f.input;
  await expect(createAdmittedWorkflowRun(db, input, { type: "agent", agentId: f.agentId, companyId: f.companyId }))
    .rejects.toThrow("workflow_revision_board_start_required");
});
