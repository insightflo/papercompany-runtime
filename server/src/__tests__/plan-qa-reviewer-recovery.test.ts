import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionPlanQaVerdicts,
  missions,
  qualityReviewItems,
  workflowDefinitions,
} from "@paperclipai/db";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip PLAN-QA reviewer recovery tests: ${support.reason ?? "unsupported"}`);
function decisionComment(decision: Record<string, unknown>): string {
  return `### Mission owner plan decision\n\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``;
}

describeDb("PLAN-QA reviewer recovery", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-qa-reviewer-recovery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(qualityReviewItems);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(missionPlanDecisionSubmissions);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(missionPlanArtifacts);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });
  async function seedFixture(input: {
    selectedQaStatus: "idle" | "error";
    includeRoleQa?: boolean;
    selectedQaAssignee?: "selected" | "owner" | "producer";
  }) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const selectedQaAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    const roleQaAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PLAN-QA Recovery Co",
      issuePrefix: `QR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: selectedQaAgentId, companyId, name: "Selected Reviewer", role: "researcher", status: input.selectedQaStatus, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: replacementAgentId, companyId, name: "Replacement Reviewer", role: "researcher", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ...(input.includeRoleQa
        ? [{ id: roleQaAgentId, companyId, name: "Generic QA", role: "qa", status: "idle" as const, adapterType: "codex_local" as const, adapterConfig: {}, runtimeConfig: {}, permissions: {} }]
        : []),
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Prepare a reviewed report",
      description: "Produce one report and review it before delivery.",
      status: "planning",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      title: "Mission owner planning",
      originKind: "mission_main_executor_plan",
      status: "done",
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const decision = {
      missionId,
      missionGoal: "Produce and independently review one report.",
      selectedPlanTemplateIds: [],
      selectedExecutionUnits: [
        {
          id: "unit-report",
          kind: "mission_plan_unit",
          title: "[ACTION] Produce the report",
          assigneeAgentId: producerAgentId,
          selectionState: "selected",
          reason: "The report is the requested outcome.",
          expectedOutput: "Registered report workProduct.",
          acceptanceCriteria: ["The report addresses the request."],
          evidenceRequired: ["Registered report path."],
          sourceRef: { type: "mission_plan_unit", id: "unit-report" },
          dependsOn: [],
          toolNames: [],
          toolArgs: {},
          knowledgeBaseIds: [],
          skillRefs: [],
          graphWorkProductRequired: true,
        },
        {
          id: "unit-report-qa",
          kind: "mission_plan_unit",
          title: "[QA] Review the report",
          assigneeAgentId: input.selectedQaAssignee === "owner"
            ? ownerAgentId
            : input.selectedQaAssignee === "producer"
              ? producerAgentId
              : selectedQaAgentId,
          selectionState: "selected",
          reason: "The report needs an independent verdict.",
          expectedOutput: "Official report verdict.",
          acceptanceCriteria: ["Check the report against the request."],
          evidenceRequired: ["Fresh review of the report path."],
          sourceRef: { type: "mission_plan_unit", id: "unit-report-qa" },
          dependsOn: ["unit-report"],
          toolNames: [],
          toolArgs: { reportPath: "{$steps.unit-report.workProductPath}" },
          knowledgeBaseIds: [],
          skillRefs: [],
          graphWorkProductRequired: false,
        },
      ],
      requiredInputs: [],
      successCriteria: [{ criterion: "A reviewed report exists.", proof: "Registered report and QA verdict." }],
      steps: [],
    };
    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
    });
    return { companyId, missionId, planningIssueId, selectedQaAgentId, replacementAgentId, roleQaAgentId };
  }

  async function activePlanState(companyId: string, missionId: string) {
    const [plan] = await db.select().from(missionPlanArtifacts).where(and(
      eq(missionPlanArtifacts.companyId, companyId),
      eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active"),
    )).limit(1);
    const refs = plan.refs as { selectedExecutionUnits?: Array<Record<string, unknown>>; planQa?: { issueId?: string } };
    const [planQaIssue] = refs.planQa?.issueId
      ? await db.select().from(issues).where(eq(issues.id, refs.planQa.issueId)).limit(1)
      : [];
    return { refs, planQaIssue };
  }

  it("reselects only the unavailable QA assignee and keeps the accepted plan", async () => {
    const f = await seedFixture({ selectedQaStatus: "error" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });

    expect(result.status).toBe("plan_qa_pending");
    const { refs, planQaIssue } = await activePlanState(f.companyId, f.missionId);
    const units = refs.selectedExecutionUnits ?? [];
    expect(units.find((unit) => unit.id === "unit-report")?.assigneeAgentId).not.toBe(f.replacementAgentId);
    expect(units.find((unit) => unit.id === "unit-report-qa")?.assigneeAgentId).toBe(f.replacementAgentId);
    expect(planQaIssue?.assigneeAgentId).toBe(f.replacementAgentId);
  });

  it("updates the accepted plan when its QA assignee enters error while PLAN-QA is pending", async () => {
    const f = await seedFixture({ selectedQaStatus: "idle" });
    const firstResult = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
    });
    expect(firstResult.status).toBe("plan_qa_pending");

    const { planQaIssue: initialPlanQaIssue } = await activePlanState(f.companyId, f.missionId);
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, f.selectedQaAgentId));
    await db.update(issues).set({
      status: "blocked",
      executionAgentNameKey: "failed-reviewer",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, initialPlanQaIssue!.id));
    const enqueuePlanQaWakeup = vi.fn(async () => undefined);
    const retryResult = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
      enqueuePlanQaWakeup,
    });

    expect(retryResult.status).toBe("plan_qa_pending");
    const { refs, planQaIssue } = await activePlanState(f.companyId, f.missionId);
    expect(refs.selectedExecutionUnits?.find((unit) => unit.id === "unit-report-qa")?.assigneeAgentId)
      .toBe(f.replacementAgentId);
    expect(planQaIssue?.assigneeAgentId).toBe(f.replacementAgentId);
    expect(planQaIssue?.status).toBe("todo");
    expect(planQaIssue?.executionAgentNameKey).toBeNull();
    expect(planQaIssue?.executionLockedAt).toBeNull();
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      agentId: f.replacementAgentId,
      issueId: initialPlanQaIssue!.id,
      issueStatus: "todo",
    }));

    const firstRecoveryActivities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "mission.plan.qa_assignee_reselected"),
    ));
    expect(firstRecoveryActivities).toHaveLength(1);

    const unchangedRetry = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
    });
    expect(unchangedRetry.status).toBe("plan_qa_pending");
    const unchangedRecoveryActivities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "mission.plan.qa_assignee_reselected"),
    ));
    expect(unchangedRecoveryActivities).toHaveLength(1);
  });

  it("uses the plan-selected runnable QA assignee instead of a separate role allowlist", async () => {
    const f = await seedFixture({ selectedQaStatus: "idle", includeRoleQa: true });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });

    expect(result.status).toBe("plan_qa_pending");
    const { planQaIssue } = await activePlanState(f.companyId, f.missionId);
    expect(planQaIssue?.assigneeAgentId).toBe(f.selectedQaAgentId);
    expect(planQaIssue?.assigneeAgentId).not.toBe(f.roleQaAgentId);

    await db.update(issues).set({ assigneeAgentId: f.roleQaAgentId }).where(eq(issues.id, planQaIssue!.id));
    const recovered = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
    });
    expect(recovered.status).toBe("plan_qa_pending");
    const { planQaIssue: recoveredPlanQaIssue } = await activePlanState(f.companyId, f.missionId);
    expect(recoveredPlanQaIssue?.assigneeAgentId).toBe(f.selectedQaAgentId);
  });

  it("does not let the mission owner or producer become the PLAN-QA reviewer", async () => {
    for (const selectedQaAssignee of ["owner", "producer"] as const) {
      const f = await seedFixture({
        selectedQaStatus: "idle",
        includeRoleQa: true,
        selectedQaAssignee,
      });

      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
        db,
        companyId: f.companyId,
        missionId: f.missionId,
      });

      expect(result.status).toBe("plan_qa_pending");
      const { planQaIssue } = await activePlanState(f.companyId, f.missionId);
      expect(planQaIssue?.assigneeAgentId).toBe(f.roleQaAgentId);
    }
  });
});
