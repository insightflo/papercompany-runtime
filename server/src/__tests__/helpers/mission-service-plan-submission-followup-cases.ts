import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missionPlanDecisionSubmissions, missions, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";

export function registerMissionPlanSubmissionFollowupCases(getDb: () => ReturnType<typeof createDb>) {
  it("active supervision reopens PLAN with rejected submission reason instead of missing-submission wording", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const planQaIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const decisionHash = "rejected-decision-hash";
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Rejected Submission Company",
      issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Rejected submission mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "RS-PLAN",
        title: "[PLAN] Rejected submission mission",
        status: "done",
        completedAt: new Date("2026-07-04T03:11:09.147Z"),
      },
      {
        id: planQaIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_plan_qa",
        identifier: "RS-QA",
        title: "[QA] Rejected submission mission plan",
        status: "done",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "RS-OVERSIGHT",
        title: "[OVERSIGHT] Rejected submission mission",
        status: "todo",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-07-04T03:06:44.526Z"),
      finishedAt: new Date("2026-07-04T03:11:09.108Z"),
      createdAt: new Date("2026-07-04T03:06:44.502Z"),
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "rejected-submission-workflow",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-07-04T03:12:00.000Z"),
    });
    await db.insert(missionPlanDecisionSubmissions).values({
      companyId,
      missionId,
      planningIssueId: planIssueId,
      authorAgentId: ownerAgentId,
      sourceRunId: succeededRunId,
      decisionHash,
      decision: { selectedExecutionUnits: [] },
      status: "rejected",
      rejectionReason: "invalid_selected_execution_unit_source_ref",
      diagnostics: [{ code: "workflow_definition_not_found", message: "Workflow definition missing" }],
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-04T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings.join("\n")).toContain("plan_submission_rejected");
    expect(missionResult?.findings.join("\n")).not.toContain("plan_submission_missing");
    expect(missionResult?.findings.join("\n")).toContain("workflow_definition_not_found");
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_rejected",
        planIssueId,
        decisionHash,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission rejected"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: expect.stringMatching(new RegExp(`^mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-[a-f0-9]{12}$`)),
      wakeCommentId: expect.any(String),
    }));
  });

  it("does not treat a reusable workflow mission without a PLAN issue as missing plan submission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Mission Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Reusable workflow mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Reusable Workflow",
      stepsJson: [{ id: "run", name: "Run", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "manual",
      status: "completed",
      completedAt: new Date("2026-06-28T03:10:00.000Z"),
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      missionIds: [missionId],
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });

    // [settlement contract] 실행이 완료된 재사용 워크플로 미션은 이제 정리(settle) 대상이다:
    //   선택되어 mission 이 completed 로 수렴하지만, plan 이슈 생성/누락 취급은 여전히 하지 않는다.
    expect(result.missionIds).toContain(missionId);
    expect(onPlanSubmissionMissing).not.toHaveBeenCalled();
    const planIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_plan"));
    expect(planIssues).toHaveLength(0);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settleActions = result.missions[0]?.appliedActions.filter((action) => action.type === "mission_settled_from_workflow_runs") ?? [];
    expect(settleActions).toHaveLength(1);
  });

  it("re-wakes an existing stale owner-action issue with no heartbeat instead of duplicating it", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action No Run Company", issuePrefix: `ON${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action no-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action No Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action with no heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_no_execution"),
      expect.stringContaining(ownerAction.identifier ?? ownerAction.id),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "blocked" }),
    }));
  });
}
