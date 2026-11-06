// Mission owner plan decision (recordLatestAuthorizedMissionOwnerPlanDecision) cases.
// Slice: validation + legacy ref merge + noop/ledger/revision + markdown-only noop cases.
// Split out of mission-owner-plan-decisions.test.ts (T16d, file <=1000 lines). Case bodies are
// moved verbatim: db, seed helpers and file-scope fixtures are injected by the caller so the
// describe-level embedded-postgres lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issues, missionPlanArtifacts, missionPlanDecisionSubmissions, workflowDefinitions } from "@paperclipai/db";
import { hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision, type MissionOwnerPlanAssessment } from "../../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";

type RecordedOwnerPlanResult = Awaited<ReturnType<typeof recordLatestAuthorizedMissionOwnerPlanDecision>>;

export function registerOwnerPlanRecordValidationLedgerCases(deps: {
  getDb: () => ReturnType<typeof createDb>;
  seedFullMissionFixture: () => Promise<{ companyId: string; ownerAgentId: string; otherAgentId: string; missionId: string; planningIssueId: string }>;
  recordThroughQaPass: (opts: { companyId: string; missionId: string }) => Promise<RecordedOwnerPlanResult>;
  validAssessment: MissionOwnerPlanAssessment;
  decisionComment: (decision: Record<string, unknown>) => string;
}) {
  const { getDb, seedFullMissionFixture, recordThroughQaPass, validAssessment, decisionComment } = deps;

  // Late-bound: the caller assigns its describe-scoped db in beforeAll, which is registered
  // before this hook, so every case sees the live connection.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  // Test 2: Invalid mission id returns invalid / no revision / no activity
  it("returns invalid for unknown or cross-company mission with no revision or activity", async () => {
    const { companyId, missionId } = await seedFullMissionFixture();
    const wrongMissionId = randomUUID();
    const wrongCompanyId = randomUUID();

    // Cross-company: wrong company, correct mission id
    const resultCross = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: wrongCompanyId,
      missionId,
    });
    expect(resultCross.status).toBe("invalid");

    // Unknown mission: correct company, wrong mission id
    const resultMissing = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId,
      missionId: wrongMissionId,
    });
    expect(resultMissing.status).toBe("invalid");

    // No revisions created
    const plans = await db.select().from(missionPlanArtifacts);
    expect(plans).toHaveLength(0);

    // No activity logged
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  // Test 3: Unknown/cross-company workflow sourceRef rejected
  it("rejects selectedExecutionUnits with cross-company workflow sourceRef, no revision, no activity", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create workflow definition in a DIFFERENT company
    const otherCompanyId = randomUUID();
    const wfOtherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `OC${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: wfOtherCompanyId,
      companyId: otherCompanyId,
      name: "Other Company Workflow",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
    });

    // Add decision with cross-company sourceRef
    const commentId = randomUUID();
    const decision = {
      missionId,
      selectedExecutionUnits: [
        {
          id: `wf:${wfOtherCompanyId}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Selected",
          sourceRef: { type: "workflow_definition_step", id: wfOtherCompanyId, stepId: "smoke" },
        },
      ],
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");

    // No new revision
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1); // only initial plan
    expect(plans[0]!.revision).toBe(1);

    // No activity
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  it("rejects PLAN mission units assigned to non-runnable agents", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const errorAgentId = randomUUID();
    await db.insert(agents).values({
      id: errorAgentId,
      companyId,
      name: "Unavailable Agent",
      role: "worker",
      status: "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const errorAgentDecision = {
      missionId,
      missionGoal: "Do not dispatch to unavailable agents",
      selectedExecutionUnits: [
        {
          id: "unit-error-agent",
          kind: "mission_plan_unit",
          title: "Should not run",
          assigneeAgentId: errorAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-error-agent" },
        },
      ],
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: errorAgentDecision, decisionHash: hashOwnerPlanDecision(errorAgentDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toBe("invalid_selected_execution_unit_source_ref");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "assignee_agent_not_runnable",
        message: expect.stringContaining("status=error"),
      }),
    ]);

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Do not dispatch to unavailable agents"));
    expect(paqoDefinitions).toHaveLength(0);
  });

  it("rejects PLAN mission units assigned to Hermes liaison agents", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const hermesAgentId = randomUUID();
    await db.insert(agents).values({
      id: hermesAgentId,
      companyId,
      name: "Hermes Operations Manager",
      role: "pm",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {
        domain: "operations",
        operatingMode: "chief_of_staff_liaison",
        authorityBoundary: { missionActionRoute: "signal_main_executor" },
      },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const hermesDecision = {
      missionId,
      missionGoal: "Publish a manual without dispatching liaison agents directly",
      selectedExecutionUnits: [
        {
          id: "unit-publish-manual",
          kind: "mission_plan_unit",
          title: "[ACTION] Publish approved manual",
          assigneeAgentId: hermesAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-publish-manual" },
          toolNames: ["manual-onboarding-publish"],
        },
      ],
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: hermesDecision, decisionHash: hashOwnerPlanDecision(hermesDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toBe("invalid_selected_execution_unit_source_ref");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "assignee_agent_role_boundary",
        message: expect.stringContaining("Hermes Operations Manager"),
      }),
    ]);
  });

  it("materializes PLAN mission units assigned to currently running agents", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const runningAgentId = randomUUID();
    await db.insert(agents).values({
      id: runningAgentId,
      companyId,
      name: "Busy but runnable agent",
      role: "worker",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const runningAgentDecision = {
      missionId,
      missionGoal: "Dispatch after current run",
      selectedExecutionUnits: [
        {
          id: "unit-running-agent",
          kind: "mission_plan_unit",
          title: "Run after current assignment",
          assigneeAgentId: runningAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-running-agent" },
        },
      ],
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: runningAgentDecision, decisionHash: hashOwnerPlanDecision(runningAgentDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Dispatch after current run"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ agentId: string }>;
    expect(paqoSteps[0]?.agentId).toBe(runningAgentId);
  });

  it("omits malformed assessment without blocking valid plan materialization", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Assessment Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const malformedAssessmentDecision = {
      missionId,
      selectedExecutionUnits: [
        {
          id: `wf:${wfId}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "Required",
          sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "run" },
        },
      ],
      assessment: { ...validAssessment, assetEvaluation: "not-an-array" },
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: malformedAssessmentDecision, decisionHash: hashOwnerPlanDecision(malformedAssessmentDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(2);
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan!.revision).toBe(2);
    const refs = activePlan!.refs as Record<string, unknown>;
    expect(refs.ownerPlanDecision).toMatchObject({
      planningIssueId,
      decisionHash: expect.any(String),
      assessment: expect.objectContaining({
        objectiveRestatement: validAssessment.objectiveRestatement,
        gaps: validAssessment.gaps,
      }),
    });
    expect((refs.ownerPlanDecision as Record<string, unknown>).assessment).not.toHaveProperty("assetEvaluation");

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
  });

  // Test 4: Existing legacy refs preserved/merged
  it("preserves existing v2 legacy refs and merges with v3 selectedExecutionUnits", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create referenced workflow definitions
    const wfLegacyId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfLegacyId,
      companyId,
      name: "Legacy Workflow",
    });

    // Create initial plan with v2 legacy refs
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {
        schemaVersion: 2,
        executionUnits: [
          { sourceRef: { type: "native_workflow_run", id: "run-legacy-1" }, status: "completed" },
        ],
        ruleRefs: [{ id: "approval-before-publish", mode: "approval_gate" }],
        oversightIssueId: "legacy-issue-1",
      },
      requiredInputs: [{ key: "qa-owner", status: "missing" }],
      successCriteria: [{ description: "Legacy criterion" }],
      steps: [{ id: "legacy-step", title: "Legacy step", status: "completed" }],
    });

    // Add valid decision with v3 selectedExecutionUnits
    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Revised rollout plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfLegacyId}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Required",
          sourceRef: { type: "workflow_definition_step", id: wfLegacyId, stepId: "smoke" },
        },
      ],
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan).toBeDefined();

    const refs = activePlan!.refs as Record<string, unknown>;
    // v2 executionUnits preserved
    expect(Array.isArray(refs.executionUnits)).toBe(true);
    expect((refs.executionUnits as unknown[]).length).toBe(1);
    // v2 ruleRefs preserved
    expect(Array.isArray(refs.ruleRefs)).toBe(true);
    expect((refs.ruleRefs as unknown[]).length).toBe(1);
    // v3 selectedExecutionUnits added
    expect(Array.isArray(refs.selectedExecutionUnits)).toBe(true);
    expect((refs.selectedExecutionUnits as unknown[]).length).toBe(1);
    // schemaVersion upgraded to 3
    expect(refs.schemaVersion).toBe(3);
    // legacy arbitrary key preserved
    expect(refs.oversightIssueId).toBe("legacy-issue-1");
  });

  // Test 5: Idempotent rerun same decision
  it("returns noop when same authorized decision comment has already been recorded", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    const wfIdemId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfIdemId,
      companyId,
      name: "Idempotency Workflow",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const commentId = randomUUID();
    const decision = {
      missionId,
      selectedExecutionUnits: [
        {
          id: `wf:${wfIdemId}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "Required",
          sourceRef: { type: "workflow_definition_step", id: wfIdemId, stepId: "run" },
        },
      ],
      assessment: validAssessment,
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    // First call should record
    const result1 = await recordThroughQaPass({ companyId, missionId });
    expect(result1.status).toBe("recorded");

    // Second call should be noop with the same decision hash, including assessment content
    const result2 = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result2.status).toBe("noop");
    expect(result2.decisionHash).toBe(result1.status === "recorded" ? result1.decisionHash : undefined);
    const submissionRows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, missionId));
    expect(submissionRows).toEqual([expect.objectContaining({ decisionHash: result2.decisionHash, status: "recorded" })]);

    // Verify only one revision was created (plus initial = 2 total plans)
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(2); // initial + one recorded revision

    // Verify only one activity log entry
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
  });

  // Test 6: Later valid authorized decision creates next revision
  it("creates next revision when a newer authorized decision supersedes prior active", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    const wfV1Id = randomUUID();
    const wfV2Id = randomUUID();
    await db.insert(workflowDefinitions).values([
      { id: wfV1Id, companyId, name: "Workflow V1" },
      { id: wfV2Id, companyId, name: "Workflow V2" },
    ]);

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    // First decision comment
    const commentId1 = randomUUID();
    const decision1 = {
      missionId,
      missionGoal: "V1 plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfV1Id}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "First decision",
          sourceRef: { type: "workflow_definition_step", id: wfV1Id, stepId: "run" },
        },
      ],
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision1, decisionHash: hashOwnerPlanDecision(decision1 as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result1 = await recordThroughQaPass({ companyId, missionId });
    expect(result1.status).toBe("recorded");
    if (result1.status !== "recorded") return;
    expect(result1.revision).toBe(2);

    // Second (newer) decision comment
    const commentId2 = randomUUID();
    const decision2 = {
      missionId,
      missionGoal: "V2 updated plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfV2Id}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "Second decision",
          sourceRef: { type: "workflow_definition_step", id: wfV2Id, stepId: "run" },
        },
      ],
    };

    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: decision2, decisionHash: hashOwnerPlanDecision(decision2 as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result2 = await recordThroughQaPass({ companyId, missionId });
    expect(result2.status).toBe("recorded");
    if (result2.status !== "recorded") return;
    expect(result2.revision).toBe(3);
    expect(result2.commentId).toBeNull();

    // Verify plan history
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(3);
    const active = plans.find((p) => p.status === "active");
    expect(active!.revision).toBe(3);
    expect(active!.missionGoal).toBe("V2 updated plan");
    const refs = active!.refs as Record<string, unknown>;
    expect(refs.selectedExecutionUnits).toEqual([
      expect.objectContaining({ id: `wf:${wfV2Id}:step:run` }),
    ]);
    expect(JSON.stringify(refs.selectedExecutionUnits)).not.toContain(wfV1Id);

    // Verify 2 activity log entries
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(2);
  });

  // Test 7: Non-planning issue JSON-looking comment ignored via collector
  it("ignores JSON-looking comments on non-planning issues and returns noop", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create a non-planning issue
    const workflowIssueId = randomUUID();
    await db.insert(issues).values({
      id: workflowIssueId,
      companyId,
      missionId,
      title: "Workflow execution issue",
      originKind: "workflow_execution",
      status: "in_progress",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    // Add JSON-looking decision comment on NON-planning issue
    await db.insert(issueComments).values({
      companyId,
      issueId: workflowIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({
        missionId,
        selectedExecutionUnits: [
          {
            id: "wf:wf-fake:step:run",
            selectionState: "selected",
            reason: "Should be ignored",
            sourceRef: { type: "workflow_definition_step", id: "wf-fake", stepId: "run" },
          },
        ],
      }),
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.reason).toBe("no_authorized_decision");
      expect(result.planningIssueId).toBe(planningIssueId);
    }

    // No new revision
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1); // only initial plan

    // No activity
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  it("stores an invalid comment-derived owner plan decision in the submission ledger", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const missingWorkflowDecision = {
      missionId,
      selectedExecutionUnits: [{
        id: "missing-workflow-step",
        kind: "workflow_definition_step",
        selectionState: "selected",
        reason: "References a workflow that is not company-scoped",
        sourceRef: { type: "workflow_definition_step", id: randomUUID(), stepId: "run" },
      }],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: missingWorkflowDecision, decisionHash: hashOwnerPlanDecision(missingWorkflowDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toBe("invalid_selected_execution_unit_source_ref");

    const submissions = await db
      .select()
      .from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, missionId));
    expect(submissions).toEqual([
      expect.objectContaining({
        companyId,
        missionId,
        planningIssueId,
        authorAgentId: ownerAgentId,
        decisionHash: result.decisionHash,
        status: "rejected",
        rejectionReason: "invalid_selected_execution_unit_source_ref",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "workflow_definition_not_found" }),
        ]),
      }),
    ]);
  });

  it("treats Markdown-only planning comments as noop unless a structured JSON decision block exists", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });
    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: `### Mission Planning Assessment\n\nReady to plan, but this is only prose and has no accepted decision JSON block.`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.reason).toBe("no_authorized_decision");
      expect(result.planningIssueId).toBe(planningIssueId);
    }

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.revision).toBe(1);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });
}
