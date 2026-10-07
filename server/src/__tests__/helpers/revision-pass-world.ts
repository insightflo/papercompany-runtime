import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  agents, agentToolGrants, companies, issues, missionPlanArtifacts, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, type Db,
} from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { workflowAgentApiRoutes } from "../../routes/workflow-agent-api.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { submitMissionOwnerPlanDecision } from "../../services/missions/mission-plan-decision-agent-api.js";
import { checkoutReviewer } from "./plan-qa-addendum.js";
import { revisionPassPolicy } from "./revision-pass-policy.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";
import { ensurePlanQaReviewIssue } from "../../services/missions/plan-qa-reviewer-assignment.js";

export const REVISION_IDS = ["build-service-report-content", "validate-service-report-content", "unit-qa-mechanical",
  "unit-publish", "unit-verify-publish", "unit-oversight-recovery"];
export const GRAPH_DIAGNOSTICS = [{ code: "unresolved_dependency_ref",
  message: "Plan has unresolved dependency ref: validate-service-report-content." }];

// The saved exact-reproduction.ts shape: six no-delta units, two bare identities,
// dependsOn (not dependencies), and five nondependency-bearing draft steps.
// Local IDs/agents/tools replace live provenance; no production files/API/DB are read.
export async function revisionPassWorld(db: Db, root: string, strict = false, freezeCorrupt = false) {
  const companyId = randomUUID(), ownerId = randomUUID(), workerId = randomUUID(), reviewerId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Revision PASS", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values([
    { id: ownerId, companyId, name: "Owner", role: "ceo", status: "active", adapterType: "process" },
    { id: workerId, companyId, name: "Publisher", role: "editor", status: "active", adapterType: "process" },
    { id: reviewerId, companyId, name: "Reviewer", role: "qa", status: "active", adapterType: "process" },
  ]);
  for (const name of ["manual-onboarding-qa", "manual-onboarding-publish", "manual-onboarding-verify"]) {
    const [tool] = await db.insert(toolDefinitions).values({ companyId, name, description: "Local fixture",
      adapterType: "builtin", adapterConfig: {}, enabled: true }).returning();
    for (const agentId of [workerId, reviewerId]) await db.insert(agentToolGrants).values({
      companyId, agentId, toolId: tool!.id, grantedBy: "test-board" });
  }
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: ownerId,
    title: "Source", status: "completed" }).returning();
  const sourceIds = [REVISION_IDS[0]!, REVISION_IDS[1]!, "qa-service-report-content",
    "publish-onboarding-manual", "verify-onboarding-manual-publish"];
  const sourceSteps = sourceIds.map(id => ({ id, name: id, type: "agent", agentId: workerId, dependencies: [] }));
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Source",
    stepsJson: sourceSteps }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition!.id,
    missionId: sourceMission!.id, triggeredBy: "manual" });
  await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: ownerId, title: "Publish report revision",
    description: "Publish and verify the report.", status: "planning", sourceMissionId: sourceMission!.id,
    sourceWorkflowRunId: sourceRun!.id }).returning();
  const [planning] = await db.insert(issues).values({ companyId, missionId: mission!.id, title: "PLAN", status: "done",
    originKind: "mission_main_executor_plan", assigneeAgentId: ownerId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId: mission!.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  const selected = (id: string, extra: Record<string, unknown>) => ({ id, kind: "mission_plan_unit", title: id,
    sourceRef: { type: "mission_plan_unit", id }, selectionState: "selected", reason: "Report revision", ...extra });
  const units: Record<string, unknown>[] = [
    { id: REVISION_IDS[0], sourceStepId: REVISION_IDS[0], assigneeAgentId: workerId,
      sourceRef: { type: "mission_plan_unit", id: REVISION_IDS[0] } },
    { id: REVISION_IDS[1], sourceStepId: REVISION_IDS[1], assigneeAgentId: reviewerId,
      sourceRef: { type: "mission_plan_unit", id: REVISION_IDS[1] } },
    selected("unit-qa-mechanical", { type: "tool", qaType: "action", sourceStepId: "qa-service-report-content",
      assigneeAgentId: reviewerId, toolNames: ["manual-onboarding-qa"], dependsOn: ["validate-service-report-content"],
      toolArgs: { content: "{$steps.build-service-report-content.workProductPath}", section: "{$runMetadata.section}",
        assetsDir: "{$steps.build-service-report-content.siblingAssetsDir}" }, graphWorkProductRequired: false }),
    selected("unit-publish", { type: "action", sourceStepId: "publish-onboarding-manual", assigneeAgentId: workerId,
      toolNames: ["manual-onboarding-publish"], dependsOn: ["unit-qa-mechanical"],
      toolArgs: { id: "{$runDate}-svc-{$runMetadata.slug}", date: "{$runDate}", section: "{$runMetadata.section}",
        visibility: "{$runMetadata.visibility}", qaResultPath: "{$steps.unit-qa-mechanical.workProductPath}",
        sourceAssetDir: "{$steps.build-service-report-content.siblingAssetsDir}",
        sourceContentPath: "{$steps.build-service-report-content.workProductPath}" }, graphWorkProductRequired: true }),
    selected("unit-verify-publish", { type: "qa", qaType: "delivery", sourceStepId: "verify-onboarding-manual-publish",
      assigneeAgentId: reviewerId, toolNames: ["manual-onboarding-verify"], dependsOn: ["unit-publish"],
      toolArgs: { id: "{$runDate}-svc-{$runMetadata.slug}", section: "{$runMetadata.section}",
        visibility: "{$runMetadata.visibility}", expectedDate: "{$runDate}",
        publishResultPath: "{$steps.unit-publish.workProductPath}" }, graphWorkProductRequired: false }),
    selected("unit-oversight-recovery", { type: "oversight", assigneeAgentId: reviewerId,
      toolNames: [], toolArgs: {}, dependsOn: [], graphWorkProductRequired: false }),
  ];
  const templateIds = strict ? [await revisionPassPolicy(db, companyId)] : [];
  const decision: Record<string, unknown> = { missionId: mission!.id, missionGoal: "Publish and verify report",
    selectedExecutionUnits: units, selectedPlanTemplateIds: templateIds, ruleRefs: [], kbRefs: [], requiredInputs: [],
    successCriteria: ["Published report verified"], steps: REVISION_IDS.slice(0, 5).map(id => ({ id, title: id })),
    assessment: { objectiveRestatement: "Publish and verify report", availableAssetsReviewed: ["Source"],
      assetEvaluation: ["Existing tools"], gaps: [], researchPerformed: ["Read source"] } };
  const submit = (raw = decision) => submitMissionOwnerPlanDecision({ db, issue: planning!,
    actor: { actorType: "agent", actorId: ownerId }, decision: raw });
  const first = await submit();
  if (first.status !== "plan_qa_pending") throw new Error(`Fixture submission failed: ${JSON.stringify(first)}`);
  const active = async () => {
    const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, companyId),
      eq(missionPlanArtifacts.missionId, mission!.id), eq(missionPlanArtifacts.status, "active")));
    if (!plan) throw new Error("Missing fixture active plan");
    return plan;
  };
  if (freezeCorrupt) {
    // Historical corrupt input fixture: pin its invalid graph via the existing generation mechanism,
    // before review starts. Never forge a marker/hash or allow old PASS to cover changed input.
    const plan = await active(), refs = plan.refs as Record<string, unknown>;
    await db.update(missionPlanArtifacts).set({ refs: { ...refs, selectedExecutionUnits:
      (refs.selectedExecutionUnits as Record<string, unknown>[]).filter(u => u.id !== "validate-service-report-content") } })
      .where(eq(missionPlanArtifacts.id, plan.id));
    const review = await ensurePlanQaReviewIssue({ db, companyId, missionId: mission!.id,
      missionTitle: mission!.title, missionDescription: mission!.description, planningIssueId: planning!.id,
      decisionHash: first.decisionHash, planArtifactId: plan.id, preferredReviewerAgentId: reviewerId });
    first.planQaIssueId = review.id;
  }
  const app = express();
  const runId = await checkoutReviewer(db, { companyId, issueId: first.planQaIssueId, reviewerAgentId: reviewerId,
    executionEpoch: 1 });
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "agent", source: "agent_jwt", companyId,
    agentId: reviewerId, runId }; next(); });
  app.use("/api", workflowAgentApiRoutes(db));
  app.use(errorHandler);
  const base = `/api/issues/${first.planQaIssueId}/mission-plan-qa`;
  const input = (await request(app).get(`${base}/input`).expect(200)).body.data;
  const checks = [];
  for (const check of input.manifest.checks) {
    const read = await request(app).post(`${base}/read`).send({ checkId: check.checkId, pointers: ["/missionId"] }).expect(201);
    checks.push({ checkId: check.checkId, status: "satisfied", readRef: read.body.data.readRef, evidence: [] });
  }
  const pass = () => request(app).post(`${base}/verdict`).send(checks.length
    ? { schemaVersion: 2, verdict: "pass", checks }
    : { verdict: "pass" }).expect(response => {
      if (response.status !== 200) throw new Error(`PASS failed: ${response.status} ${JSON.stringify(response.body)}`);
    });
  const corrupt = async () => {
    const plan = await active();
    const refs = plan.refs as Record<string, unknown>;
    const pending = refs.selectedExecutionUnits as Record<string, unknown>[];
    // Deliberate negative fixture: only persisted refs are corrupt; raw/hash/review remain frozen.
    await db.update(missionPlanArtifacts).set({ refs: { ...refs,
      selectedExecutionUnits: pending.filter(u => u.id !== "validate-service-report-content") } })
      .where(eq(missionPlanArtifacts.id, plan.id));
  };
  return { companyId, ownerId, workerId, reviewerId, mission: mission!, planning: planning!, decision,
    first, active, submit, pass, corrupt, input, app, base };
}
