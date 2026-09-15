// [T7 fixture] PLAN-QA manifest attachments create assets rows (company FK 없음) → 정리 추가.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  assets,
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
import { recordMissionOwnerPlanDecisionSubmission } from "../services/missions/mission-plan-decision-submissions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip PLAN-QA reviewer recovery tests: ${support.reason ?? "unsupported"}`);

// [T7 격리] recordLatest 가 PLAN-QA manifest 를 StorageService 에 기록하므로 기본 인스턴스
// storage(~/.paperclip) 대신 suite 전용 임시 디렉터리로 돌린다(T12 전역 주입 전 임시 차단).
let planQaStorageRoot: string | null = null;
beforeAll(async () => {
  planQaStorageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-pqrr-storage-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", planQaStorageRoot);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (planQaStorageRoot) await rm(planQaStorageRoot, { recursive: true, force: true });
});

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
    await db.delete(assets);
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
    return {
      companyId,
      missionId,
      planningIssueId,
      selectedQaAgentId,
      replacementAgentId,
      roleQaAgentId,
      ownerAgentId,
      decision,
    };
  }

  async function submitPlan(f: Awaited<ReturnType<typeof seedFixture>>) {
    return recordMissionOwnerPlanDecisionSubmission({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
      planningIssueId: f.planningIssueId,
      requestedBy: { actorType: "agent", actorId: f.ownerAgentId },
      decision: f.decision,
    });
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

    const result = await submitPlan(f);

    expect(result.status).toBe("plan_qa_pending");
    const { refs, planQaIssue } = await activePlanState(f.companyId, f.missionId);
    const units = refs.selectedExecutionUnits ?? [];
    expect(units.find((unit) => unit.id === "unit-report")?.assigneeAgentId).not.toBe(f.replacementAgentId);
    expect(units.find((unit) => unit.id === "unit-report-qa")?.assigneeAgentId).toBe(f.replacementAgentId);
    expect(planQaIssue?.assigneeAgentId).toBe(f.replacementAgentId);
  });

  it("updates the accepted plan when its QA assignee enters error while PLAN-QA is pending", async () => {
    const f = await seedFixture({ selectedQaStatus: "idle" });
    const firstResult = await submitPlan(f);
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
      // [T7] 검토 중 실행 단위(assignee recovery)가 바뀌면 새 reviewGeneration 이슈로 세대가 갱신된다.
      issueId: planQaIssue!.id,
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

    const result = await submitPlan(f);

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

      const result = await submitPlan(f);

      expect(result.status).toBe("plan_qa_pending");
      const { planQaIssue } = await activePlanState(f.companyId, f.missionId);
      expect(planQaIssue?.assigneeAgentId).toBe(f.roleQaAgentId);
    }
  });
});
