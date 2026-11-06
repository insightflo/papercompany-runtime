// Mission owner plan decision (recordLatestAuthorizedMissionOwnerPlanDecision) cases.
// Slice: plan-QA gate + structured verdict cases.
// Split out of mission-owner-plan-decisions.test.ts (T16d, file <=1000 lines). Case bodies are
// moved verbatim: db, seed helpers and file-scope fixtures are injected by the caller so the
// describe-level embedded-postgres lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi, beforeAll } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issues, missionPlanTemplates, missionPlanDecisionSubmissions, missionPlanQaVerdicts, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision, type MissionOwnerPlanDecisionPayload } from "../../services/mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import { recordMissionOwnerPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-submissions.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { issueService } from "../../services/issues.js";
import { setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { missionService } from "../../services/missions.js";

type RecordedOwnerPlanResult = Awaited<ReturnType<typeof recordLatestAuthorizedMissionOwnerPlanDecision>>;

export function registerOwnerPlanRecordQaGateCases(deps: {
  getDb: () => ReturnType<typeof createDb>;
  seedFullMissionFixture: () => Promise<{ companyId: string; ownerAgentId: string; otherAgentId: string; missionId: string; planningIssueId: string }>;
  seedReadyResearchWorkbenchPlugin: () => Promise<void>;
  seedQaFixture: () => Promise<{ companyId: string; ownerAgentId: string; qaAgentId: string; missionId: string; planningIssueId: string; sourceWorkflowId: string }>;
  postDecisionComment: (opts: { companyId: string; issueId: string; authorAgentId: string; missionId: string; sourceWorkflowId: string; unitId?: string; selectedPlanTemplateIds?: string[] }) => Promise<void>;
  postPlanQaVerdict: (opts: { companyId: string; missionId: string; verdict: "pass" | "request_changes"; authorAgentId: string; detail?: string }) => Promise<void>;
  countWorkflowDefinitions: (companyId: string) => Promise<number>;
  recordThroughQaPass: (opts: { companyId: string; missionId: string }) => Promise<RecordedOwnerPlanResult>;
  validDecision: MissionOwnerPlanDecisionPayload;
  planQaScorecardPassComment: () => string;
}) {
  const { getDb, seedFullMissionFixture, seedReadyResearchWorkbenchPlugin, seedQaFixture, postDecisionComment, postPlanQaVerdict, countWorkflowDefinitions, recordThroughQaPass, validDecision, planQaScorecardPassComment } = deps;

  // Late-bound: the caller assigns its describe-scoped db in beforeAll, which is registered
  // before this hook, so every case sees the live connection.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  it("plan-QA gate: a new decision creates a [PLAN-QA] issue and defers materialization (pending)", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    expect(result.status).toBe("plan_qa_pending");

    const planQaIssues = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa")));
    expect(planQaIssues).toHaveLength(1);
    expect(planQaIssues[0]!.assigneeAgentId).toBe(qaAgentId);
    expect(planQaIssues[0]!.description).toContain("PASS");
    expect(planQaIssues[0]!.description).toContain("REQUEST_CHANGES");
    expect(planQaIssues[0]!.description).toContain("/mission-plan-qa/verdict");
    expect(planQaIssues[0]!.description).toContain("Do not use `/workflow/verdict`");
    expect(planQaIssues[0]!.description).toContain("Verdict standard");
    expect(planQaIssues[0]!.description).toContain("resource_gap");
    expect(planQaIssues[0]!.description).toContain("action_contract_gap");
    expect(planQaIssues[0]!.description).toContain("verification_gap");
    expect(enqueuePlanQaWakeup).toHaveBeenCalledTimes(1);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      issueId: planQaIssues[0]!.id,
      issueStatus: "todo",
      missionId,
      planningIssueId,
    }));
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("records an explicit agent template selection and gives its exact body to PLAN-QA", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    const templateId = randomUUID();
    await db.insert(missionPlanTemplates).values({
      id: templateId,
      companyId,
      key: "custom-test-template",
      name: "Custom test template",
      selectionDescription: "Use for this test mission.",
      instructions: "EXACT SELECTED TEMPLATE BODY",
      origin: "custom",
      enabled: true,
    });
    await postDecisionComment({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      missionId,
      sourceWorkflowId,
      selectedPlanTemplateIds: [templateId],
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect((plan?.refs as Record<string, unknown>).planTemplates).toMatchObject({
      selectionSource: "agent",
      items: [{ id: templateId, key: "custom-test-template" }],
    });
    const [planQaIssue] = await db.select({ description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa")));
    expect(planQaIssue?.description).toContain("EXACT SELECTED TEMPLATE BODY");
  });

  it("plan-QA gate: accepts a revised owner decision posted on the existing PLAN-QA issue and ignores stale prior verdicts", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId, unitId: "unit-original" });

    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const firstPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const firstPlanQa = (firstPlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    const planQaIssueId = firstPlanQa?.issueId;
    expect(planQaIssueId).toBeTruthy();

    await db.insert(issueComments).values({
      companyId,
      issueId: planQaIssueId!,
      authorAgentId: qaAgentId,
      body: "Plan has gaps.\nREQUEST_CHANGES: split publish and QA",
      createdAt: new Date("2027-01-01T00:01:00.000Z"),
    });

    const revisedDecision = {
      ...validDecision,
      missionId,
      selectedExecutionUnits: [{
        id: "unit-revised",
        kind: "workflow_definition_step",
        title: "Run revised smoke",
        reason: "revised source evidence",
        selectionState: "selected",
        sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" },
      }],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: revisedDecision, decisionHash: hashOwnerPlanDecision(revisedDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const revisedPending = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(revisedPending.status).toBe("plan_qa_pending");

    const revisedPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const revisedRefs = revisedPlan?.refs as Record<string, unknown>;
    expect(revisedPlan?.revision).toBe(3);
    expect((revisedRefs.planQa as { issueId?: string } | undefined)?.issueId).toBeTruthy();
    expect(JSON.stringify(revisedRefs)).toContain("unit-revised");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });

    const materialized = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(materialized.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("records a structured owner plan decision without reading issue comments (structured-events p3)", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    const decision = {
      ...validDecision,
      missionId,
      selectedExecutionUnits: [{
        id: "unit-structured",
        kind: "workflow_definition_step",
        title: "Run smoke",
        reason: "source evidence",
        sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" },
      }],
    };

    const result = await recordMissionOwnerPlanDecisionSubmission({
      db,
      companyId,
      missionId,
      planningIssueId,
      decision,
      requestedBy: { actorType: "agent", actorId: ownerAgentId },
    });

    // gate always active → plan_qa_pending (no materialize until PASS)
    expect(result.status).toBe("plan_qa_pending");

    const submissions = await db
      .select()
      .from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, missionId));
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.decisionHash).toBe(result.decisionHash);
    // no issue comment was posted (structured path, not comment-parse)
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    expect(comments).toHaveLength(0);
  });

  it("stores a rejected structured owner plan decision with ledger diagnostics", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedQaFixture();
    const result = await recordMissionOwnerPlanDecisionSubmission({
      db,
      companyId,
      missionId,
      planningIssueId,
      decision: {
        ...validDecision,
        missionId,
        selectedExecutionUnits: [{
          id: "structured-missing-workflow",
          kind: "workflow_definition_step",
          title: "Run missing workflow",
          reason: "source evidence",
          selectionState: "selected",
          sourceRef: { type: "workflow_definition_step", id: randomUUID(), stepId: "scout" },
        }],
      },
      requestedBy: { actorType: "agent", actorId: ownerAgentId },
      sourceRunId: randomUUID(),
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;

    const submissions = await db
      .select()
      .from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, missionId));
    expect(submissions).toEqual([
      expect.objectContaining({
        decisionHash: result.decisionHash,
        status: "rejected",
        rejectionReason: "invalid_selected_execution_unit_source_ref",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "workflow_definition_not_found" }),
        ]),
      }),
    ]);
  });

  it("PLAN-QA: natural-language scorecard/PASS comments never write mission_plan_qa_verdicts nor materialize", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    // record the plan decision to create the pending PLAN-QA issue
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    const pendingPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const pendingPlanQa = (pendingPlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string } | undefined;
    expect(pendingPlanQa?.status).toBe("pending");
    expect(pendingPlanQa?.issueId).toBeTruthy();
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    // natural-language scorecard + explicit PASS comments — display only, never authoritative
    await issueService(db).addComment(pendingPlanQa!.issueId!, planQaScorecardPassComment(), { agentId: qaAgentId });
    await issueService(db).addComment(pendingPlanQa!.issueId!, "Plan is sound.\nPASS", { agentId: qaAgentId });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");

    const verdictRows = await db
      .select()
      .from(missionPlanQaVerdicts)
      .where(eq(missionPlanQaVerdicts.missionId, missionId));
    expect(verdictRows).toHaveLength(0);

    const materializedPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const materializedPlanQa = (materializedPlan?.refs as Record<string, unknown> | undefined)?.planQa as { verdict?: string; status?: string } | undefined;
    expect(materializedPlanQa?.status).toBe("pending");
    expect(materializedPlanQa?.verdict).toBeUndefined();
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: does not assign or wake an existing terminal unassigned Plan QA issue during reprocess", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();

    // 1차 record: [PLAN-QA] issue 생성.
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    const [created] = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(created).toBeTruthy();
    // 이미 종료(done) + 미할당 상태로 시뮬레이션 — 과거 검토가 끝났으나 할당이 비어있는 경우.
    await db.update(issues).set({ status: "done", assigneeAgentId: null, updatedAt: new Date() }).where(eq(issues.id, created!.id));
    enqueuePlanQaWakeup.mockClear();

    // [AREA: Plan QA / Task 0] 재처리 시 terminal/unactionable 상태면 재할당/재wakeup 금지.
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);

    expect(planQaIssue?.status).toBe("done");
    expect(planQaIssue?.assigneeAgentId).toBeNull();
    expect(enqueuePlanQaWakeup).not.toHaveBeenCalled();
  });

  it("plan-QA gate: description embeds the original request and adaptive quality contract", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    const [planQaIssue] = await db.select({ description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue?.description).toContain("Mission quality contract");
    expect(planQaIssue?.description).toContain("Select an executable plan for the original business request.");
    expect(planQaIssue?.description).toContain("Adaptive quality profile");
    expect(planQaIssue?.description).toContain("blocking defect");
  });

  it("plan-QA gate: PASS verdict materializes the PAQO workflow and records verdict=pass", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
    const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs.length).toBeGreaterThan(0);
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { verdict?: string } | undefined;
    expect(planQa?.verdict).toBe("pass");
    const [planQaIssue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue.status).toBe("done");
  });

  it("plan-QA gate: REQUEST_CHANGES blocks materialization and reopens the PLAN issue to actionable", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    const enqueuePlanningIssueWakeup = vi.fn().mockResolvedValue(null);
    await db.update(issues).set({ status: "done", assigneeAgentId: ownerAgentId }).where(eq(issues.id, planningIssueId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    await postPlanQaVerdict({ companyId, missionId, verdict: "request_changes", authorAgentId: qaAgentId });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanningIssueWakeup });
    expect(result.status).toBe("plan_qa_changes_requested");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, planningIssueId));
    expect(planIssue.status).toBe("todo");
    expect(enqueuePlanningIssueWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      issueId: planningIssueId,
      issueStatus: "todo",
      missionId,
      decisionHash: expect.any(String),
    }));
    const [planQaIssue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue.status).toBe("done");
  });

  it("plan-QA gate: the newest authorized explicit verdict wins by createdAt even when an older PASS is inserted later", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, planningIssueId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    expect(planQa?.issueId).toBeDefined();
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });
    await postPlanQaVerdict({ companyId, missionId, verdict: "request_changes", authorAgentId: qaAgentId, detail: "add publish smoke QA" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_changes_requested");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, planningIssueId));
    expect(planIssue.status).toBe("todo");
  });

  it("plan-QA gate: ignores PASS verdicts from non-QA agents", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    expect(planQa?.issueId).toBeDefined();
    await db.insert(issueComments).values({
      companyId,
      issueId: planQa!.issueId!,
      authorAgentId: ownerAgentId,
      body: "Mission owner tries to approve their own plan.\nPASS",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const unauthorizedPass = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(unauthorizedPass.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });

    const qaPass = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(qaPass.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("plan-QA gate: reprocessing the same decision hash does not duplicate the [PLAN-QA] issue and stays deferred", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    expect(second.status).toBe("plan_qa_pending");

    const planQaIssues = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa")));
    expect(planQaIssues).toHaveLength(1);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledTimes(2);
    expect(enqueuePlanQaWakeup).toHaveBeenLastCalledWith(expect.objectContaining({
      issueId: planQaIssues[0]!.id,
      missionId,
      planningIssueId,
    }));
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: a PASS verdict on an older decision hash does not pass a newer decision (no stale PASS leak)", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #1 (hash A)
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId }); // PASS on hash A gate

    // newer decision (hash B) — must NOT be passed by the stale hash-A PASS
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId, unitId: "unit-2" });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: after REQUEST_CHANGES a revised decision opens a new gate and materializes only on its own PASS", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #1
    await postPlanQaVerdict({ companyId, missionId, verdict: "request_changes", authorAgentId: qaAgentId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // changes_requested
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    // revised decision (new hash) -> new gate
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId, unitId: "unit-2" });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #2
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId }); // PASS on new gate
    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("plan-QA gate: a qa-role agent with status=idle is still selected as reviewer and the gate applies", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    const [qa] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "qa"))).limit(1);
    if (qa) await db.update(agents).set({ status: "idle" }).where(eq(agents.id, qa.id));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBe(qa?.id ?? null);
  });

  it("plan-QA gate: a qa-role agent with status=running is still selected and queued", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, qaAgentId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });

    expect(result.status).toBe("plan_qa_pending");
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBe(qaAgentId);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      missionId,
      planningIssueId,
    }));
  });

  it("plan-QA gate: reprocessing an unassigned gate assigns a newly available reviewer and queues it", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const sourceWorkflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Recover Plan QA Source Workflow", stepsJson: [{ id: "run", name: "Run", dependencies: [] }] });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const initial = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(initial.status).toBe("plan_qa_pending");
    const [unassignedPlanQaIssue] = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(unassignedPlanQaIssue).toBeDefined();
    expect(unassignedPlanQaIssue.assigneeAgentId).toBeNull();

    const qaAgentId = randomUUID();
    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "Late Report Validator",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    const enqueuePlanQaWakeup = vi.fn();
    const recovered = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });

    expect(recovered.status).toBe("plan_qa_pending");
    const [recoveredPlanQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(eq(issues.id, unassignedPlanQaIssue.id)).limit(1);
    expect(recoveredPlanQaIssue.assigneeAgentId).toBe(qaAgentId);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      issueId: unassignedPlanQaIssue.id,
      missionId,
      planningIssueId,
    }));
  });

  it("plan-QA gate: with no qa/reviewer/validator agent the [PLAN-QA] issue is created unassigned and materialization stays blocked", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "NoQA Source Workflow", stepsJson: [{ id: "run", name: "Run", dependencies: [] }] });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "unit-1", kind: "workflow_definition_step", title: "Run smoke", reason: "x", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "run" } }] };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId, description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBeNull();
    expect(planQaIssue.description).toContain("QA reviewer assignment required");
  });

  it("structured plan-qa verdict: request_changes verdict is stored and readPlanQaVerdict returns it structured-first", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    // 1차 record → plan_qa_pending, [PLAN-QA] issue 생성
    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    expect(planQa?.issueId).toBeTruthy();

    // structured verdict 저장(request_changes) — comment 없이 표에 직접
    const verdictResult = await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: planQa!.issueId!,
      decisionHash: first.decisionHash ?? planQa!.decisionHash ?? "",
      verdict: "request_changes",
      diagnostics: [{ code: "missing_publish_readback_qa", message: "publish QA is missing" }],
      reviewedBy: { actorType: "agent", actorId: qaAgentId },
    });
    expect(verdictResult.status).toBe("recorded");

    // mission_plan_qa_verdicts 표에 row 존재
    const verdictRows = await db.select().from(missionPlanQaVerdicts)
      .where(eq(missionPlanQaVerdicts.planQaIssueId, planQa!.issueId!));
    expect(verdictRows).toHaveLength(1);
    expect(verdictRows[0]?.verdict).toBe("request_changes");

    // 2차 record → readPlanQaVerdict 가 structured-first 로 읽어서 request_changes 적용
    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(second.status).toBe("plan_qa_changes_requested");
  });

  it("structured plan-qa verdict: pass verdict is stored and materialization proceeds on next tick", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    expect(planQa?.issueId).toBeTruthy();

    // structured verdict 저장(pass)
    await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: planQa!.issueId!,
      decisionHash: first.decisionHash ?? planQa!.decisionHash ?? "",
      verdict: "pass",
      reviewedBy: { actorType: "agent", actorId: qaAgentId },
    });

    // With the comment-driven materialization hook removed, the structured PASS
    // verdict materializes on this explicit next recordLatest tick.
    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(second.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("[PLAN-QA structured PASS recovery] structured PASS row + pending active refs recovers on re-record (A1 stuck-state)", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    // materialization 이 실제로 실행되려면 workflow tool step executor 가 필요(recovery 단계).
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const pendingPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const pendingPlanQa = (pendingPlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string } | undefined;
    expect(pendingPlanQa?.status).toBe("pending");
    expect(pendingPlanQa?.issueId).toBeTruthy();

    // A1 stuck-state 재현: structured PASS verdict row 를 표에 직접 심는다.
    //   issueService.addComment(dual-write) 경로를 우회해 materialization hook 이 터지지 않게 한다.
    //   결과: verdict row=pass 인데 refs.planQa=pending, workflow 미실체화(A1 관측 상태와 동일).
    await db.insert(missionPlanQaVerdicts).values({
      companyId,
      missionId,
      planQaIssueId: pendingPlanQa!.issueId!,
      reviewerAgentId: qaAgentId,
      reviewerUserId: null,
      sourceRunId: null,
      sourceCommentId: null,
      decisionHash: first.decisionHash ?? "",
      verdict: "pass",
      diagnostics: [],
    }).onConflictDoNothing();

    // stuck 전제 단언: verdict row=pass 인데 workflow 는 미실체화
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const runsBefore = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runsBefore.length).toBe(0);

    // 후속 recordLatest → readPlanQaVerdict 가 structured-first 로 pass 판독 → 멱등 materialize 완수
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("recorded");
    const recovered = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const recoveredPlanQa = (recovered?.refs as Record<string, unknown> | undefined)?.planQa as { status?: string; verdict?: string } | undefined;
    expect(recoveredPlanQa?.status).toBe("pass");
    expect(recoveredPlanQa?.verdict).toBe("pass");
    const paqoWorkflow = (recovered?.refs as Record<string, unknown> | undefined)?.paqoWorkflow as { workflowRunId?: string } | undefined;
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
    const runsAfter = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runsAfter.length).toBeGreaterThan(0);
  });

  it("structured plan-qa verdict: API REQUEST_CHANGES remains authoritative over a later PASS comment", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const pendingPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const pendingPlanQa = (pendingPlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    expect(pendingPlanQa?.issueId).toBeTruthy();

    await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: pendingPlanQa!.issueId!,
      decisionHash: first.decisionHash ?? pendingPlanQa!.decisionHash ?? "",
      verdict: "request_changes",
      diagnostics: [{ code: "missing_detail", message: "needs revision" }],
      reviewedBy: { actorType: "agent", actorId: qaAgentId },
    });

    await issueService(db).addComment(
      pendingPlanQa!.issueId!,
      "Plan is now sound.\nPASS",
      { agentId: qaAgentId },
    );

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_changes_requested");

    const verdictRows = await db.select().from(missionPlanQaVerdicts)
      .where(eq(missionPlanQaVerdicts.planQaIssueId, pendingPlanQa!.issueId!));
    expect(verdictRows).toHaveLength(1);
    expect(verdictRows[0]?.verdict).toBe("request_changes");
    expect(verdictRows[0]?.sourceCommentId).toBeNull();

    const recovered = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const recoveredPlanQa = (recovered?.refs as Record<string, unknown> | undefined)?.planQa as { status?: string; verdict?: string } | undefined;
    expect(recoveredPlanQa?.status).toBe("request_changes");
    expect(recoveredPlanQa?.verdict).toBe("request_changes");
    const paqoWorkflow = (recovered?.refs as Record<string, unknown> | undefined)?.paqoWorkflow as { workflowRunId?: string } | undefined;
    expect(paqoWorkflow?.workflowRunId).toBeUndefined();
  });

  it("[PLAN-QA materialization gap] active supervision selects a planning mission with PASS verdict but no PAQO workflow", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await db
      .update(missions)
      .set({ status: "planning" })
      .where(eq(missions.id, missionId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    const pendingPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const pendingPlanQa = (pendingPlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string } | undefined;
    expect(pendingPlanQa?.status).toBe("pending");
    expect(pendingPlanQa?.issueId).toBeTruthy();

    await db.insert(missionPlanQaVerdicts).values({
      companyId,
      missionId,
      planQaIssueId: pendingPlanQa!.issueId!,
      reviewerAgentId: qaAgentId,
      reviewerUserId: null,
      sourceRunId: null,
      sourceCommentId: null,
      decisionHash: first.decisionHash ?? "",
      verdict: "pass",
      diagnostics: [],
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 30,
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "materialize_plan_decision", resultStatus: "recorded" }),
    ]));

    const recovered = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const recoveredPlanQa = (recovered?.refs as Record<string, unknown> | undefined)?.planQa as { status?: string; verdict?: string } | undefined;
    expect(recoveredPlanQa?.status).toBe("pass");
    expect(recoveredPlanQa?.verdict).toBe("pass");
    const paqoWorkflow = (recovered?.refs as Record<string, unknown> | undefined)?.paqoWorkflow as { workflowRunId?: string } | undefined;
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
  });

  it("[PLAN-QA materialization failure] writes durable diagnostic activity, stays pending, recovers on retry", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId } = await seedQaFixture();
    // tool-bearing unit 으로 PAQO step 가 toolNames 를 갖게 한다. 그래야
    //   assertWorkflowToolStepsReady(dag-engine.ts:189) 가 early-return 하지 않고
    //   executor null 을 검사(198-200)해서 throw 한다. executor 자체를 throw 시켜도
    //   dag-engine 이 삼키기 때문에(2196 catch → failToolStepRunWithDispatchError, return false),
    //   전파하려면 반드시 null-executor 경로로 ensurePaqo 를 터뜨려야 한다.
    await db.update(companies).set({ workProductRoot: "/tmp/paperclip-test-work-products" }).where(eq(companies.id, companyId));
    // plugin 을 등록해 tool 을 "selectable" 로 만든다. 그래야 createDefinition 이 통과하고,
    //   throw 지점이 createDefinition(tool 미등록)이 아니라 executeWorkflowRun(executor null)이 된다.
    await seedReadyResearchWorkbenchPlugin();
    const toolFailDecision = {
      missionId,
      missionGoal: validDecision.missionGoal,
      selectedExecutionUnits: [{
        id: "unit-tool-fail",
        kind: "mission_plan_unit",
        title: "Collect cited evidence",
        assigneeAgentId: ownerAgentId,
        selectionState: "selected",
        reason: "tool-bearing unit to force executor readiness check",
        sourceRef: { type: "mission_plan_unit", id: "unit-tool-fail" },
        toolNames: ["insightflo.research-workbench:research-search"],
        dependsOn: [],
      }],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["evidence bundle ready"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, decision: toolFailDecision, decisionHash: hashOwnerPlanDecision(toolFailDecision as Parameters<typeof hashOwnerPlanDecision>[0]), authorAgentId: ownerAgentId, status: "submitted" });
    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(first.status).toBe("plan_qa_pending");
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });

    // materialization 강제 실패: workflow tool step executor 를 끄면
    //   ensurePaqoWorkflow → executeWorkflowRun → assertWorkflowToolStepsReady 가 throw.
    setWorkflowToolStepExecutor(null);
    let threw = false;
    try {
      await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // durable diagnostic: A1 사례처럼 stranded state 가 됐을 때 유일한 DB 단서.
    const failed = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "mission.owner_plan.materialization_failed")));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.entityType).toBe("mission");
    expect(failed[0]!.entityId).toBe(missionId);
    expect(failed[0]!.details).toMatchObject({
      step: "ensure_paqo_workflow",
      decisionHash: first.decisionHash,
    });
    expect((failed[0]!.details as { error?: string }).error).toBeTruthy();

    // 상태는 pending 유지(멱등 재시도 가능). updatePlanQaRef(pass) 는 throw 이후 단계라 미실행.
    const stuckPlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const stuckPlanQa = (stuckPlan?.refs as Record<string, unknown> | undefined)?.planQa as { status?: string } | undefined;
    expect(stuckPlanQa?.status).toBe("pending");

    // 재시도: executor 복구 → 후속 recordLatest 가 structured pass row 를 읽어 멱등하게 materialize 완수.
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("recorded");
    const recovered = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const recoveredPlanQa = (recovered?.refs as Record<string, unknown> | undefined)?.planQa as { status?: string; verdict?: string } | undefined;
    expect(recoveredPlanQa?.status).toBe("pass");
    expect(recoveredPlanQa?.verdict).toBe("pass");
    const paqoWorkflow = (recovered?.refs as Record<string, unknown> | undefined)?.paqoWorkflow as { workflowRunId?: string } | undefined;
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
    setWorkflowToolStepExecutor(null);
  });
}
