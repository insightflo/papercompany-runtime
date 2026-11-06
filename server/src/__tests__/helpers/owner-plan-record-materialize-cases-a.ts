// Mission owner plan decision (recordLatestAuthorizedMissionOwnerPlanDecision) cases.
// Slice: materialization cases 1-9 (revision create, ownership drift, critique hook, PAQO DAG materialize).
// Split out of mission-owner-plan-decisions.test.ts (T16d, file <=1000 lines). Case bodies are
// moved verbatim: db, seed helpers and file-scope fixtures are injected by the caller so the
// describe-level embedded-postgres lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi, beforeAll } from "vitest";
import { activityLog, companies, createDb, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision, type MissionOwnerPlanAssessment } from "../../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { setMissionPlanQaCritiqueHook, type PlanQaDiagnostic } from "../../services/missions/mission-plan-qa.js";
import { setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";

type RecordedOwnerPlanResult = Awaited<ReturnType<typeof recordLatestAuthorizedMissionOwnerPlanDecision>>;

export function registerOwnerPlanRecordMaterializeCasesA(deps: {
  getDb: () => ReturnType<typeof createDb>;
  seedFullMissionFixture: () => Promise<{ companyId: string; ownerAgentId: string; otherAgentId: string; missionId: string; planningIssueId: string }>;
  seedReadyResearchWorkbenchPlugin: () => Promise<void>;
  recordThroughQaPass: (opts: { companyId: string; missionId: string }) => Promise<RecordedOwnerPlanResult>;
  validAssessment: MissionOwnerPlanAssessment;
}) {
  const { getDb, seedFullMissionFixture, seedReadyResearchWorkbenchPlugin, recordThroughQaPass, validAssessment } = deps;

  // Late-bound: the caller assigns its describe-scoped db in beforeAll, which is registered
  // before this hook, so every case sees the live connection.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  // Test 1: Valid owner decision creates revision 2
  it("creates revision 2 with selectedExecutionUnits, refs, requiredInputs, successCriteria, steps and logs mission.owner_plan.recorded", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create referenced workflow definition in same company
    const wfPlan1Id = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfPlan1Id,
      companyId,
      name: "Smoke Test Workflow",
    });

    // Create initial plan (revision 1)
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    // Add valid decision comment
    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Ship controlled rollout",
      selectedExecutionUnits: [
        {
          id: `wf:${wfPlan1Id}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Required for validation",
          sourceRef: { type: "workflow_definition_step", id: wfPlan1Id, stepId: "smoke" },
        },
      ],
      ruleRefs: ["rule:security"],
      kbRefs: ["kb:rollout"],
      assessment: validAssessment,
      requiredInputs: ["stagingUrl"],
      successCriteria: ["smoke passes"],
      steps: [{ id: "step-1", title: "Verify staging" }],
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.revision).toBe(2);
    expect(result.commentId).toBeNull();

    // Verify the plan artifact was created
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan).toBeDefined();
    expect(activePlan!.revision).toBe(2);
    expect(activePlan!.missionGoal).toBe("Ship controlled rollout");

    const refs = activePlan!.refs as Record<string, unknown>;
    expect(refs.selectedExecutionUnits).toBeDefined();
    expect(Array.isArray(refs.selectedExecutionUnits)).toBe(true);
    expect((refs.selectedExecutionUnits as unknown[]).length).toBe(1);
    expect(refs.ownerPlanDecision).toMatchObject({
      planningIssueId,
      commentId: null,
      decisionHash: expect.any(String),
      assessment: validAssessment,
    });

    expect(activePlan!.requiredInputs).toEqual(["stagingUrl"]);
    expect(activePlan!.successCriteria).toEqual(["smoke passes"]);
    expect(activePlan!.steps).toEqual([{ id: "step-1", title: "Verify staging" }]);

    // Verify activity log
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.entityType).toBe("mission");
    expect(activities[0]!.entityId).toBe(missionId);
    expect(activities[0]!.companyId).toBe(companyId);
    expect(activities[0]!.details).toMatchObject({
      missionPlanArtifactId: activePlan!.id,
      revision: 2,
      planningIssueId,
      commentId: null,
      decisionMakerKind: "agent",
      decisionMakerId: ownerAgentId,
      decisionHash: expect.any(String),
      idempotencyKey: expect.any(String),
    });
  });

  it("[P1 ownership-drift] planning issue assignee 가 mission owner 와 불일치하면 ownership_drift 로 fail-fast 한다", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Drift Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Drift test",
      selectedExecutionUnits: [{
        id: `wf:${wfId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required",
        sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" },
      }],
      ruleRefs: [],
      kbRefs: [],
      assessment: validAssessment,
      requiredInputs: [],
      successCriteria: ["smoke passes"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    // drift: planning issue 를 mission owner 가 아닌 agent 에게 재할당
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, planningIssueId));

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toBe("ownership_drift");
    expect(result.diagnostics.some((d) => d.code === "ownership_drift")).toBe(true);
  });

  it("[P1 ownership-drift] planning issue assignee == mission owner 면 drift 없이 materialize 한다", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Owner Assigned Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Owner assigned",
      selectedExecutionUnits: [{
        id: `wf:${wfId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required",
        sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" },
      }],
      ruleRefs: [],
      kbRefs: [],
      assessment: validAssessment,
      requiredInputs: [],
      successCriteria: ["smoke passes"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    // owner 에게 명시 할당 → drift 없음
    await db.update(issues).set({ assigneeAgentId: ownerAgentId }).where(eq(issues.id, planningIssueId));

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
  });

  it("[P2 critique] LLM critique hook 이 invalid diagnostic 을 추가하면 materialization 을 차단한다", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Critique Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Critique test",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: ["smoke passes"], steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    // title "Planning mission" → deterministic 없음. critique 가 invalid 추가 → 차단.
    setMissionPlanQaCritiqueHook(async () => [{ code: "missing_publish_unit", severity: "invalid", message: "critique: publish missing" }] as PlanQaDiagnostic[]);
    try {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.diagnostics.some((d) => d.code === "missing_publish_unit")).toBe(true);
    } finally {
      setMissionPlanQaCritiqueHook(null);
    }
  });

  it("mission prose does not introduce deterministic publication rejection", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await db.update(missions).set({ title: "가이드를 site에 올리도록" }).where(eq(missions.id, missionId));
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Det Hold Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Det hold test",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: [], steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    setMissionPlanQaCritiqueHook(async () => [{ code: "missing_audience_split", severity: "needs_clarification", message: "soft" }] as PlanQaDiagnostic[]);
    try {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
      expect(result.status).toBe("plan_qa_pending");
    } finally {
      setMissionPlanQaCritiqueHook(null);
    }
  });

  it("does not log rejection solely from mission publication wording", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await db.update(missions).set({ title: "가이드를 site에 올리도록" }).where(eq(missions.id, missionId));
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Surface Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "surface",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: [], steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    const rejected = await db.select().from(activityLog).where(eq(activityLog.action, "mission.plan.rejected"));
    expect(rejected).toEqual([]);
  });

  it("materializes selected execution units into a mission-scoped PAQO workflow DAG with ACTION gated before QA", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await db
      .update(companies)
      .set({ workProductRoot: "/tmp/paperclip-test-work-products" })
      .where(eq(companies.id, companyId));
    const sourceWorkflowId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowId,
      companyId,
      name: "Source Research Workflow",
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate PAQO workflow pivot",
      selectedExecutionUnits: [
        {
          id: "research-scout",
          kind: "workflow_definition_step",
          title: "Research current workflow surfaces",
          reason: "Need source evidence before synthesis",
          expectedOutput: "A current workflow-surface evidence report",
          acceptanceCriteria: ["Every conclusion is traceable to a cited source"],
          evidenceRequired: ["Source URL and collection timestamp"],
          sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: ["workflow source evidence"],
      successCriteria: ["QA verifies the synthesized result"],
      steps: [{ id: "qa", title: "Verify synthesized result" }],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate PAQO workflow pivot"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{
      id: string;
      name: string;
      dependencies: string[];
      agentId: string;
      description?: string;
      graphWorkProductRequired?: boolean;
    }>;
    expect(paqoSteps.map((step) => step.name)).toEqual([
      "[ACTION] Research current workflow surfaces",
      "[QA] Verify mission result",
    ]);
    expect(paqoSteps[0]!.agentId).toBe(ownerAgentId);
    expect(paqoSteps[0]!.graphWorkProductRequired).toBe(true);
    expect(paqoSteps[0]!.description).toContain("Expected output: A current workflow-surface evidence report");
    expect(paqoSteps[0]!.description).toContain("Acceptance criteria: Every conclusion is traceable to a cited source");
    expect(paqoSteps[0]!.description).toContain("Evidence required: Source URL and collection timestamp");
    expect("toolNames" in paqoSteps[0]!).toBe(false);
    expect(paqoSteps[1]!.graphWorkProductRequired).toBe(false);
    expect(paqoSteps[1]!.dependencies).toEqual([paqoSteps[0]!.id]);
    // [P5 control-flow loop] ACTION producer 에 QA rework back-edge 가 합성되었는지(wiring 회귀 감지).
    const paqoStepsRaw = paqoDefinitions[0]!.stepsJson as Array<{
      id: string;
      conditionalDependencies?: Array<{ stepId: string; when: string; isBackEdge?: boolean; maxIterations?: number }>;
    }>;
    const actionWithEdge = paqoStepsRaw.find((step) => step.id === paqoSteps[0]!.id)!;
    expect(actionWithEdge.conditionalDependencies).toEqual([
      { stepId: paqoSteps[1]!.id, when: "qa_request_changes", isBackEdge: true, maxIterations: 2, allowCapAcceptance: true },
    ]);
    expect(paqoStepsRaw.find((step) => step.id === paqoSteps[1]!.id)!.conditionalDependencies).toBeUndefined();

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ companyId, missionId, status: "running" });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    const actionRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[0]!.id);
    const qaRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[1]!.id);
    expect(actionRun?.issueId).toEqual(expect.any(String));
    expect(actionRun?.status).toBe("pending");
    expect(qaRun?.issueId).toBeNull();
    expect(qaRun?.status).toBe("pending");

    const actionIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, actionRun!.issueId!))
      .then((rows) => rows[0]);
    expect(actionIssue).toMatchObject({
      companyId,
      missionId,
      title: "[ACTION] Research current workflow surfaces",
      originKind: "workflow_execution",
      originRunId: runs[0]!.id,
      parentId: null,
    });
    expect(actionIssue?.title).not.toContain("PAQO WBS");
    expect(actionIssue?.description).toContain("Deliverable output (use exactly this directory):");
    expect(actionIssue?.description).toContain("WorkProduct registration contract:");
    expect(actionIssue?.description).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(actionIssue?.description).toContain("This is the only registration authority.");
    expect(actionIssue?.description).toContain("Do not use the generic workProduct route");
    expect(actionIssue?.description).toContain("or an `[ARTIFACT]` marker to register");
    expect(actionIssue?.description).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(actionIssue?.description).not.toMatch(/\[ARTIFACT\]:\s*<absolute path>/);
    expect(actionIssue?.description).toContain("Evidence explanation quality");
    expect(actionIssue?.description).toContain("source content -> observation -> interpretation -> conclusion");
    expect(paqoSteps[1]!.description).toContain("Evidence explanation quality");
    expect(paqoSteps[1]!.description).toContain("source content -> observation -> interpretation -> conclusion");
    expect(paqoSteps[1]!.description).toContain("REQUEST_CHANGES");
    expect(paqoSteps[1]!.description).toContain("A current workflow-surface evidence report");
    expect(paqoSteps[1]!.description).toContain("Every conclusion is traceable to a cited source");
    expect(paqoSteps[1]!.description).toContain("Source URL and collection timestamp");

    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      paqoWorkflow: {
        workflowDefinitionId: paqoDefinitions[0]!.id,
        workflowRunId: runs[0]!.id,
        workflowName: "PAQO WBS: Validate PAQO workflow pivot",
        stepIds: paqoSteps.map((step) => step.id),
        decisionHash: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });

    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_oversight"));
    expect(oversightIssues).toHaveLength(0);
  });

  it("does not add tools from search-oriented PLAN prose even when a plugin is ready", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await seedReadyResearchWorkbenchPlugin();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const researchDecision = {
      missionId,
      missionGoal: "Research current market evidence",
      selectedExecutionUnits: [
        {
          id: "unit-source-search",
          kind: "mission_plan_unit",
          title: "Search current external sources",
          assigneeAgentId: ownerAgentId,
          selectionState: "selected",
          reason: "Need current source evidence before synthesis",
          sourceRef: { type: "mission_plan_unit", id: "unit-source-search" },
          dependsOn: [],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["sources collected"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: researchDecision, decisionHash: hashOwnerPlanDecision(researchDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Research current market evidence"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ name: string; toolNames?: string[] }>;
    expect(paqoSteps[0]?.name).toBe("[ACTION] Search current external sources");
    expect(paqoSteps[0]?.toolNames).toBeUndefined();
  });

  it("preserves PLAN-selected workflow tools, KBs, and skill rationale on materialized steps", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await seedReadyResearchWorkbenchPlugin();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const toolFitDecision = {
      missionId,
      missionGoal: "Evaluate tools and skills before research",
      selectedExecutionUnits: [
        {
          id: "unit-tool-fit",
          kind: "mission_plan_unit",
          title: "Collect cited evidence",
          assigneeAgentId: ownerAgentId,
          selectionState: "selected",
          reason: "PLAN selected Research Workbench and the research skill for source collection",
          sourceRef: { type: "mission_plan_unit", id: "unit-tool-fit" },
          toolNames: ["insightflo.research-workbench:research-search"],
          toolArgs: { maxResults: 3 },
          knowledgeBaseIds: ["kb-research-policy"],
          skillRefs: ["research-helper"],
          dependsOn: [],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["evidence bundle ready"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: toolFitDecision, decisionHash: hashOwnerPlanDecision(toolFitDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Evaluate tools and skills before research"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{
      toolNames?: string[];
      toolArgs?: unknown;
      knowledgeBaseIds?: string[];
      description?: string;
    }>;
    expect(paqoSteps[0]).toMatchObject({
      toolNames: ["insightflo.research-workbench:research-search"],
      toolArgs: { maxResults: 3 },
      knowledgeBaseIds: ["kb-research-policy"],
    });
    expect(paqoSteps[0]!.description).toContain("Skill refs considered by PLAN: research-helper");
  });
}
