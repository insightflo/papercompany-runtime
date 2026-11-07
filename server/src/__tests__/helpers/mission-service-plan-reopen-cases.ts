import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, qualityReviewItems, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionPlanReopenCases(getDb: () => ReturnType<typeof createDb>) {
  it("active supervision reopens a completed PLAN issue when the planning run succeeded without a structured submission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Submission Missing Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning submission missing mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "PS-PLAN",
        title: "[PLAN] Planning submission missing mission",
        status: "done",
        completedAt: new Date("2026-06-28T03:11:09.147Z"),
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "PS-OVERSIGHT",
        title: "[OVERSIGHT] Planning submission missing mission",
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
      startedAt: new Date("2026-06-28T03:06:44.526Z"),
      finishedAt: new Date("2026-06-28T03:11:09.108Z"),
      createdAt: new Date("2026-06-28T03:06:44.502Z"),
    });
    await db.update(issues).set({
      checkoutRunId: succeededRunId,
      executionRunId: succeededRunId,
      executionAgentNameKey: "mission-owner",
      executionLockedAt: new Date("2026-06-28T03:06:44.526Z"),
    }).where(eq(issues.id, planIssueId));

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_submission_missing"),
    ]));

    // Phase 5 connection: the oversight stall must auto-create a company-scoped quality review item.
    const oversightQualityItems = await db
      .select()
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.missionId, missionId));
    expect(oversightQualityItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        missionId,
        triggerSource: "oversight_stall",
        targetType: "mission_output",
        failureType: "plan_submission_missing",
      }),
    ]));
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_missing", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_missing",
        planIssueId,
        succeededRunId,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const [storedPlanIssue] = await db.select().from(issues).where(eq(issues.id, planIssueId));
    expect(storedPlanIssue).toEqual(expect.objectContaining({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission required"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: `mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`,
      wakeCommentId: expect.any(String),
    }));

    await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
  });
}
