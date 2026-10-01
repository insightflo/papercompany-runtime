import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, issues, missionPlanDecisionSubmissions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision, hashOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-guard-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-guard-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
async function failedWorld(type = "agent") {
  const f = await seedWorld(db, root, mission => [{ id: "write", name: "Write", type,
    agentId: mission.ownerAgentId!, dependencies: [], graphWorkProductRequired: true }]);
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_timeout" }).where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  const { seedFromRun: _, ...input } = f.input;
  return { ...f, input };
}
// Without the guard these create durable runs despite identical failed execution.
it.each(["same", "renamed", "mapped-new-id", "unmapped-new-id", "prose-contract"] )("rejects unchanged failed execution: %s", async variant => {
  const f = await failedWorld();
  const step = { ...f.steps[0], ...(variant !== "same" ? { name: "New title", description: "New prose" } : {}),
    ...(variant.includes("new-id") ? { id: "generated-new-mission-id" } : {}),
    ...(variant === "mapped-new-id" ? { sourceStepId: "write" } : {}),
    ...(variant === "prose-contract" ? { contract: { postconditions: ["new promise"] }, metadata: { bypass: true } } : {}) };
  await db.update(workflowDefinitions).set({ stepsJson: [step] }).where(eq(workflowDefinitions.id, f.definition.id));
  await expect(createAdmittedWorkflowRun(db, f.input, board)).rejects.toThrow("mission_revision_");
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
});
it("allows changed execution config but rejects duplicate explicit mapping", async () => {
  const f = await failedWorld();
  const changed = { ...f.steps[0], id: "new", sourceStepId: "write", toolArgs: { timeout: 120 } };
  await db.update(workflowDefinitions).set({ stepsJson: [changed] }).where(eq(workflowDefinitions.id, f.definition.id));
  expect((await createAdmittedWorkflowRun(db, f.input, board)).id).toBeTruthy();
  await db.update(workflowDefinitions).set({ stepsJson: [changed, { ...changed, id: "duplicate" }] }).where(eq(workflowDefinitions.id, f.definition.id));
  await expect(createWorkflowRun(db, f.input)).rejects.toThrow("mission_revision_source_mapping_invalid");
});
it("uses historical snapshot, never the mutable source definition, and guards direct creation", async () => {
  const f = await failedWorld();
  await expect(createWorkflowRun(db, f.input)).rejects.toThrow("mission_revision_repeat_failure");
  const unrelated = { ...f.input, missionId: f.sourceMission.id };
  expect((await createWorkflowRun(db, unrelated)).id).toBeTruthy();
});
it("records a structured plan rejection before PLAN-QA or workflow materialization", async () => {
  const f = await failedWorld();
  const [planning] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id,
    title: "PLAN", originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: f.agentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: f.companyId, missionId: f.revision.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  const decision = { missionId: f.revision.id, missionGoal: "Write report", selectedPlanTemplateIds: [],
    selectedExecutionUnits: [{ id: "unit", title: "Write", selectionState: "selected", reason: "required", assigneeAgentId: f.agentId,
      sourceRef: { type: "mission_plan_unit", id: "unit" } }],
    ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    assessment: { objectiveRestatement: "Write report", availableAssetsReviewed: ["source"], assetEvaluation: ["source"], gaps: [], researchPerformed: [] } };
  await upsertMissionPlanDecisionSubmission({ db, companyId: f.companyId, missionId: f.revision.id, planningIssueId: planning.id,
    decision, decisionHash: hashOwnerPlanDecision(decision), authorAgentId: f.agentId, status: "submitted" });
  const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.revision.id });
  expect(result).toMatchObject({ status: "invalid", reason: "mission_revision_invalid",
    diagnostics: [{ code: "mission_revision_repeat_failure" }] });
  const submissions = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, f.revision.id));
  expect(submissions.some(s => s.status === "rejected" && s.rejectionReason === "mission_revision_invalid")).toBe(true);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
});
