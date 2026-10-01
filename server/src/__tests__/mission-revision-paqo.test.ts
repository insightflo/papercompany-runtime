import "./helpers/workflow-control-node-boundary.js";
import express from "express";
import request from "supertest";
import { mountMissionRevisionStart } from "../routes/mission-revision-start.js";
import { errorHandler } from "../middleware/index.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, missionPlanArtifacts, missionPlanQaVerdicts, issues, workflowDefinitions, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { ensureOwnerPlanWorkflowRun } from "../services/workflow/owner-plan-workflow-run.js";
import { loadRevisionBoardWait } from "../services/missions/revision-board-wait.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { revisionPlanDiagnostics } from "../services/missions/revision-plan-validation.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { board } from "./helpers/workflow-seed-world.js";
import { missionService } from "../services/missions.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-paqo-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-paqo-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
it("actual generated PAQO identities seed explicitly; immutable definition yields authoritative board wait", async () => {
  const draft = { missionGoal: "report", successCriteria: [], steps: [{ unitId: "u", dependencies: [] }],
    refs: { selectedExecutionUnits: [{ id: "u", title: "Write", graphWorkProductRequired: true }] } };
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(draft as never, mission));
  const sourceId = f.sourceStep.stepId;
  const units = [{ ...draft.refs.selectedExecutionUnits[0], title: "Renamed", sourceStepId: sourceId }];
  const steps = buildPaqoWorkflowSteps({ ...draft, refs: { selectedExecutionUnits: units } } as never, f.revision);
  expect(steps[0].id).not.toBe(sourceId);
  expect(steps[0]).toHaveProperty("sourceStepId", sourceId);
  expect(await revisionPlanDiagnostics(db, f.companyId, f.revision.id, units, () => steps)).toEqual([]);
  expect(await revisionPlanDiagnostics(db, f.companyId, f.revision.id, draft.refs.selectedExecutionUnits, () => steps))
    .toEqual([]);
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "PAQO revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: steps }).returning();
  const hash = "b".repeat(64);
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "QA", status: "done" }).returning();
  const [plan] = await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id,
    ownerAgentId: f.agentId, revision: 1, missionGoal: "report", refs: { ownerPlanDecision: { decisionHash: hash },
      planQa: { issueId: qa.id, decisionHash: hash }, paqoWorkflow: { workflowDefinitionId: definition.id, decisionHash: hash } } }).returning();
  await expect(createAdmittedWorkflowRun(db, { ...f.input, workflowId: definition.id, seedFromRun: undefined }, board))
    .rejects.toThrow("workflow_revision_board_start_not_ready");
  await db.insert(missionPlanQaVerdicts).values({ companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa.id,
    decisionHash: hash, verdict: "pass", reviewerUserId: "local-board" });
  expect(await ensureOwnerPlanWorkflowRun({ db, companyId: f.companyId, missionId: f.revision.id,
    workflowId: definition.id, triggeredBy: f.agentId, requirePlanQaPass: async () => {} })).toBeNull();
  expect(await loadRevisionBoardWait(db, f.companyId, f.revision.id)).toMatchObject({ workflowDefinitionId: definition.id });
  const [planning] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id,
    title: "PLAN", originKind: "mission_main_executor_plan", assigneeAgentId: f.agentId, status: "done" }).returning();
  await upsertMissionPlanDecisionSubmission({ db, companyId: f.companyId, missionId: f.revision.id, planningIssueId: planning.id,
    authorAgentId: f.agentId, decisionHash: hash, decision: { missionId: f.revision.id }, status: "submitted" });
  const supervised = await missionService(db).runMainExecutorSupervision({ missionId: f.revision.id, applySafeActions: false });
  expect(supervised.recommendations.some(r => r.type === "materialize_plan_decision")).toBe(false);
  expect(await revisionStartOptions(db, f.companyId, f.revision.id)).toMatchObject({
    sourceWorkflowRunId: f.sourceRun.id, candidates: [{ stepId: steps[0].id, sourceStepId: sourceId }] });
  const app = express(); app.use((req, _res, next) => { req.actor = board; next(); });
  const router = express.Router(); mountMissionRevisionStart(router, db); app.use("/api", router); app.use(errorHandler);
  const options = await request(app).get(`/api/missions/${f.revision.id}/revision-start`);
  expect(options.status).toBe(200);
  expect(options.body.candidates[0]).toMatchObject({ stepId: steps[0].id, sourceStepId: sourceId });
  f.input.workflowId = definition.id;
  f.input.seedFromRun.stepIds = [steps[0].id];
  const target = await f.admit();
  expect(await loadRevisionBoardWait(db, f.companyId, f.revision.id)).toBeNull();
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === steps[0].id)).toMatchObject({ status: "completed", issueId: null });
  expect((await selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id, stepId: steps[0].id,
    selector: { type: "document", title: "content.json" } })).producer.stepId).toBe(sourceId);
  await db.update(missionPlanArtifacts).set({ refs: {} }).where(eq(missionPlanArtifacts.id, plan.id));
  expect(await loadRevisionBoardWait(db, f.companyId, f.revision.id)).toBeNull();
});
