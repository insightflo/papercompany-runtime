import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { buildPaqoWorkflowSteps, hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { executeWorkflowRun, syncWorkflowRunState } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-qa-path-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-qa-path-")));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage")); }, 60000);
afterAll(async () => { vi.unstubAllEnvs(); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it("official generated QA rejection → changed plan → structured board approval → fresh board start", async () => {
  const unit = { id: "write", title: "Write", graphWorkProductRequired: true };
  const draft = { missionGoal: "report", successCriteria: [], steps: [{ unitId: "write", dependencies: [] }], refs: { selectedExecutionUnits: [unit] } };
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(draft as never, mission));
  const source = buildPaqoWorkflowSteps(draft as never, f.sourceMission);
  const qaStep = source.at(-1)!;
  const [issue] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.sourceMission.id,
    title: "[QA] Verify", originKind: "workflow_execution", status: "done", assigneeAgentId: f.agentId }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: f.sourceRun.id, stepId: qaStep.id,
    issueId: issue.id, status: "running", iterationIndex: 2 }).returning();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.sourceRun.id));
  await db.update(workflowStepRuns).set({ iterationIndex: 2 }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: issue.id, stepRunId: qa.id, heartbeatId });
  await recordWorkflowValidationVerdict({ db, issue, verdict: "request_changes", source: "workflow_api", heartbeatRunId: heartbeatId, actorAgentId: f.agentId });
  await syncWorkflowRunState(db, f.sourceRun.id);
  const [rejected] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, qa.id));
  expect(rejected.status).toBe("failed");
  const [planning] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id,
    title: "PLAN", originKind: "mission_main_executor_plan", assigneeAgentId: f.agentId, status: "done" }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: f.companyId, missionId: f.revision.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  // Corrective approach replaces the previous producer. New plan units are not obliged to reuse outputs.
  const decision = { missionId: f.revision.id, missionGoal: "Correct report", selectedPlanTemplateIds: [],
    selectedExecutionUnits: [{ id: "correct", title: "Correct report", selectionState: "selected", reason: "repair", assigneeAgentId: f.agentId,
      sourceRef: { type: "mission_plan_unit", id: "correct" }, toolArgs: { correctionMode: true } }],
    ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    assessment: { objectiveRestatement: "Correct report", availableAssetsReviewed: ["source"], assetEvaluation: ["source"], gaps: [], researchPerformed: [] } };
  await upsertMissionPlanDecisionSubmission({ db, companyId: f.companyId, missionId: f.revision.id, planningIssueId: planning.id,
    decision, decisionHash: hashOwnerPlanDecision(decision), authorAgentId: f.agentId, status: "submitted" });
  const record = () => recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.revision.id });
  expect(await record()).toMatchObject({ status: "plan_qa_pending" });
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: f.companyId, missionId: f.revision.id });
  const planQa = plan!.refs.planQa as { issueId: string; decisionHash: string };
  await recordMissionPlanQaVerdict({ db, companyId: f.companyId, missionId: f.revision.id, planQaIssueId: planQa.issueId,
    decisionHash: planQa.decisionHash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "local-board" } });
  expect(await record()).toMatchObject({ status: "recorded" });
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.missionId, f.revision.id), eq(workflowDefinitions.sourceKind, "paqo")));
  const run = await createAdmittedWorkflowRun(db, { companyId: f.companyId, missionId: f.revision.id, workflowId: definition.id, triggeredBy: "board" }, board);
  await executeWorkflowRun(db, run.id);
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))).length).toBeGreaterThan(0);
});
