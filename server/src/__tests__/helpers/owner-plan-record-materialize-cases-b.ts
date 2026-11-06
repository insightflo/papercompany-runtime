// Mission owner plan decision (recordLatestAuthorizedMissionOwnerPlanDecision) cases.
// Slice: materialization cases 10-15 (workflow tool preservation, cross-company delegation, dependencies, immutable definition, source refs).
// Split out of mission-owner-plan-decisions.test.ts (T16d, file <=1000 lines). Case bodies are
// moved verbatim: db, seed helpers and file-scope fixtures are injected by the caller so the
// describe-level embedded-postgres lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import { agents, companies, createDb, issues, missionDelegations, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision } from "../../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";

type RecordedOwnerPlanResult = Awaited<ReturnType<typeof recordLatestAuthorizedMissionOwnerPlanDecision>>;

export function registerOwnerPlanRecordMaterializeCasesB(deps: {
  getDb: () => ReturnType<typeof createDb>;
  seedFullMissionFixture: () => Promise<{ companyId: string; ownerAgentId: string; otherAgentId: string; missionId: string; planningIssueId: string }>;
  recordThroughQaPass: (opts: { companyId: string; missionId: string }) => Promise<RecordedOwnerPlanResult>;
}) {
  const { getDb, seedFullMissionFixture, recordThroughQaPass } = deps;

  // Late-bound: the caller assigns its describe-scoped db in beforeAll, which is registered
  // before this hook, so every case sees the live connection.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  it("does not materialize PAQO OVERSIGHT units as workflow DAG steps", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
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
      missionGoal: "Keep oversight outside workflow DAG",
      selectedExecutionUnits: [
        {
          id: "unit-data",
          kind: "mission_plan_unit",
          title: "[ACTION] Collect market data",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-data" },
        },
        {
          id: "unit-owner-oversight",
          kind: "oversight",
          title: "[OVERSIGHT] Owner monitors and coordinates recovery",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-owner-oversight" },
          dependsOn: ["unit-data"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["Owner oversight remains mission-level, not workflow-level"],
      steps: [
        { id: "collect", units: ["unit-data"] },
        { id: "oversee", units: ["unit-owner-oversight"], dependsOn: ["unit-data"] },
      ],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Keep oversight outside workflow DAG"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[]; agentId: string }>;
    expect(paqoSteps.map((step) => step.name)).toEqual([
      "[ACTION] Collect market data",
      "[QA] Verify mission result",
    ]);
    expect(paqoSteps.some((step) => step.name.includes("[OVERSIGHT]"))).toBe(false);
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
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns.map((stepRun) => stepRun.stepId).sort()).toEqual(paqoSteps.map((step) => step.id).sort());
  });

  it("materializes PLAN-managed mission units with explicit assignees into native DAG steps", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
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
      missionGoal: "Validate PLAN-owned assignment structure",
      selectedExecutionUnits: [
        {
          id: "unit-source-research",
          kind: "mission_plan_unit",
          title: "Research source evidence",
          assigneeAgentId: otherAgentId,
          selectionState: "selected",
          reason: "PLAN selected the worker from the company roster",
          sourceRef: { type: "mission_plan_unit", id: "unit-source-research" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["worker ACTION completes before QA"],
      steps: [{ id: "research", title: "Research source evidence" }],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate PLAN-owned assignment structure"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[]; agentId: string; description: string }>;
    expect(paqoSteps[0]).toMatchObject({
      name: "[ACTION] Research source evidence",
      agentId: otherAgentId,
    });
    expect(paqoSteps[0]!.description).toContain(`Assigned by PLAN decision to agentId: ${otherAgentId}`);
    expect(paqoSteps[1]).toMatchObject({
      name: "[QA] Verify mission result",
      agentId: ownerAgentId,
      dependencies: [paqoSteps[0]!.id],
    });

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    const actionRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[0]!.id);
    expect(actionRun?.issueId).toEqual(expect.any(String));
    const actionIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, actionRun!.issueId!))
      .then((rows) => rows[0]);
    expect(actionIssue).toMatchObject({
      companyId,
      missionId,
      title: expect.stringMatching(/^\[ACTION\] Research source evidence/),
      assigneeAgentId: otherAgentId,
      originKind: "workflow_execution",
      parentId: null,
    });
  });

  it("automatically creates cross-company delegated missions from owner PLAN selected units", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const targetCompanyId = randomUUID();
    const targetOwnerAgentId = randomUUID();

    await db.insert(companies).values({
      id: targetCompanyId,
      name: "Research Company",
      issuePrefix: `RC${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: targetOwnerAgentId,
      companyId: targetCompanyId,
      name: "Research Director",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
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
      missionGoal: "Build daily briefing dashboard",
      selectedExecutionUnits: [
        {
          id: "research-daily-brief-inputs",
          kind: "cross_company_mission",
          title: "Research daily briefing workflow inputs",
          targetCompanyId,
          targetOwnerAgentId,
          reason: "Development mission needs Research Company evidence before implementation planning",
          sourceRef: { type: "cross_company_mission", id: "research-daily-brief-inputs" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["delegated research mission returns official workProducts"],
      steps: ["delegate research to Research Company before implementation planning"],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result1 = await recordThroughQaPass({ companyId, missionId });
    const result2 = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    expect(result1.status).toBe("recorded");
    expect(result2.status).toBe("noop");

    const delegations = await db.select().from(missionDelegations).where(eq(missionDelegations.sourceMissionId, missionId));
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      sourceCompanyId: companyId,
      targetCompanyId,
      status: "active",
      externalKey: expect.stringContaining("owner-plan:"),
    });

    const sourceTracker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, delegations[0]!.sourceIssueId!))
      .then((rows) => rows[0]);
    expect(sourceTracker).toMatchObject({
      companyId,
      missionId,
      status: "blocked",
      originKind: "mission_delegation_source",
      assigneeAgentId: ownerAgentId,
    });

    const targetMission = await db
      .select()
      .from(missions)
      .where(eq(missions.id, delegations[0]!.targetMissionId))
      .then((rows) => rows[0]);
    expect(targetMission).toMatchObject({
      companyId: targetCompanyId,
      ownerAgentId: targetOwnerAgentId,
      title: "[DELEGATED] Research daily briefing workflow inputs",
      status: "planning",
    });

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Build daily briefing dashboard"));
    expect(paqoDefinitions).toHaveLength(0);

    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      crossCompanyDelegations: [
        {
          delegationId: delegations[0]!.id,
          sourceIssueId: delegations[0]!.sourceIssueId,
          targetCompanyId,
          targetMissionId: delegations[0]!.targetMissionId,
          decisionHash: expect.any(String),
        },
      ],
    });
  });

  it("preserves PLAN unit dependencies and QA grouping in the native PAQO DAG", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
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
      missionGoal: "Validate ordered PLAN unit graph",
      selectedExecutionUnits: [
        {
          id: "unit-research-a",
          kind: "mission_plan_unit",
          title: "Research source A",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-research-a" },
        },
        {
          id: "unit-research-b",
          kind: "mission_plan_unit",
          title: "Research source B",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-research-b" },
        },
        {
          id: "unit-html-synthesis",
          kind: "mission_plan_unit",
          title: "[ACTION] Write HTML report",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-html-synthesis" },
          dependsOn: ["unit-research-a", "unit-research-b"],
        },
        {
          id: "unit-qa-validation",
          kind: "qa", type: "qa",
          title: "[QA] Fact-check HTML report",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-qa-validation" },
          dependsOn: ["unit-html-synthesis"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["QA runs only after synthesis"],
      steps: ["Phase 1: parallel research", "Phase 2: synthesis", "Phase 3: QA"],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate ordered PLAN unit graph"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{
      id: string;
      name: string;
      dependencies: string[];
      description?: string;
    }>;
    const researchA = paqoSteps.find((step) => step.name === "[ACTION] Research source A");
    const researchB = paqoSteps.find((step) => step.name === "[ACTION] Research source B");
    const synthesis = paqoSteps.find((step) => step.name === "[ACTION] Write HTML report");
    const validator = paqoSteps.find((step) => step.name === "[QA] Fact-check HTML report");
    const ownerQa = paqoSteps.find((step) => step.name === "[QA] Verify mission result");

    expect(researchA?.dependencies).toEqual([]);
    expect(researchB?.dependencies).toEqual([]);
    expect(synthesis?.dependencies).toEqual(expect.arrayContaining([researchA!.id, researchB!.id]));
    expect(synthesis?.dependencies).toHaveLength(2);
    expect(validator?.dependencies).toEqual([synthesis!.id]);
    expect(ownerQa?.dependencies).toEqual(expect.arrayContaining([
      researchA!.id,
      researchB!.id,
      synthesis!.id,
      validator!.id,
    ]));
    expect(ownerQa?.dependencies).toHaveLength(4);
    expect(ownerQa?.description).toContain("Verification Before Completion");
    expect(ownerQa?.description).toContain("fresh evidence");
    expect(ownerQa?.description).toContain("Identify every completion claim");

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns.find((stepRun) => stepRun.stepId === researchA!.id)?.issueId).toEqual(expect.any(String));
    expect(stepRuns.find((stepRun) => stepRun.stepId === researchB!.id)?.issueId).toEqual(expect.any(String));
    expect(stepRuns.find((stepRun) => stepRun.stepId === synthesis!.id)?.issueId).toBeNull();
    expect(stepRuns.find((stepRun) => stepRun.stepId === validator!.id)?.issueId).toBeNull();
  });

  it("creates a new immutable PAQO definition when PLAN steps change, leaving the legacy definition untouched", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const staleDefinitionId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: staleDefinitionId,
      companyId,
      name: "PAQO WBS: Validate stale PAQO definition",
      stepsJson: [
        {
          id: "action-stale",
          name: "[ACTION] Stale action",
          agentId: ownerAgentId,
          dependencies: [],
        },
        {
          id: "qa-stale",
          name: "[QA] Verify mission result",
          agentId: ownerAgentId,
          dependencies: ["action-stale"],
        },
      ],
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
      missionGoal: "Validate stale PAQO definition",
      selectedExecutionUnits: [
        {
          id: "unit-a",
          kind: "mission_plan_unit",
          title: "Research A",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-a" },
        },
        {
          id: "unit-b",
          kind: "mission_plan_unit",
          title: "Synthesize B",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-b" },
          dependsOn: ["unit-a"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["B waits for A"],
      steps: ["A then B"],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate stale PAQO definition"));
    // [Stage 4] immutability: the legacy null-hash definition is never updated;
    // the changed plan materializes as a NEW hashed source_kind='paqo' definition.
    expect(paqoDefinitions).toHaveLength(2);
    const legacy = paqoDefinitions.find((row) => row.id === staleDefinitionId)!;
    const immutable = paqoDefinitions.find((row) => row.id !== staleDefinitionId)!;
    expect(legacy.stepsJson).toEqual([
      {
        id: "action-stale",
        name: "[ACTION] Stale action",
        agentId: ownerAgentId,
        dependencies: [],
      },
      {
        id: "qa-stale",
        name: "[QA] Verify mission result",
        agentId: ownerAgentId,
        dependencies: ["action-stale"],
      },
    ]);
    expect(legacy.missionId).toBeNull();
    expect(legacy.definitionHash).toBeNull();
    expect(legacy.sourceKind).toBeNull();
    expect(immutable.sourceKind).toBe("paqo");
    expect(immutable.missionId).toBe(missionId);
    expect(immutable.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    const paqoSteps = immutable.stepsJson as Array<{ id: string; name: string; dependencies: string[] }>;
    const research = paqoSteps.find((step) => step.name === "[ACTION] Research A");
    const synthesis = paqoSteps.find((step) => step.name === "[ACTION] Synthesize B");
    expect(research?.dependencies).toEqual([]);
    expect(synthesis?.dependencies).toEqual([research!.id]);
  });

  it("materializes selected execution units with issue sourceRefs emitted by PLAN heartbeat output", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
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
      missionGoal: "Validate live PLAN heartbeat issue refs",
      selectedExecutionUnits: [
        {
          id: "live-action-1",
          title: "Live verification action A",
          reason: "Matches process adapter PLAN stdout shape",
          sourceRef: { type: "issue", identifier: "PLAN-1", issueId: planningIssueId },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: ["live heartbeat auto-complete stdout"],
      successCriteria: ["workflowRun exists"],
      steps: ["hold QA behind dependencies"],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      paqoWorkflow: {
        workflowRunId: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns.some((stepRun) => stepRun.issueId && stepRun.status === "pending")).toBe(true);
    expect(stepRuns.some((stepRun) => stepRun.issueId === null && stepRun.status === "pending")).toBe(true);
  });
}
