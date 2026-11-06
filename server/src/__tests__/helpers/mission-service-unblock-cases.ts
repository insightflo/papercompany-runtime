import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issueComments, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { issueService } from "../../services/issues.js";

export function registerMissionUnblockCases(getDb: () => ReturnType<typeof createDb>) {
  it("creates an owner unblock action without stealing a blocked issue from its assignee", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Blocked Mission Company",
      issuePrefix: `BM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Worker Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Blocked workflow mission",
      description: "Create the daily Tech AI News note, validate the artifact, then deliver it after approval.",
      status: "active",
    });

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked delegated work",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      description: "Daily TechCrunch AI research workflow.",
      stepsJson: [
        { id: "collect-news", name: "Collect news", agentId: workerAgentId, dependencies: [] },
        { id: "generate-infographic", name: "Generate infographic", agentId: workerAgentId, dependencies: ["collect-news"] },
        { id: "validate-ai-news-artifact", name: "Validate AI news artifact", agentId: workerAgentId, dependencies: ["generate-infographic"] },
        { id: "send-telegram", name: "Send Telegram", agentId: ownerAgentId, dependencies: ["validate-ai-news-artifact"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "schedule",
      status: "failed",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
      completedAt: new Date("2026-06-14T06:17:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId,
        stepId: "collect-news",
        issueId: null,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:03:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "generate-infographic",
        issueId: null,
        status: "completed",
        startedAt: new Date("2026-06-14T06:03:00.000Z"),
        completedAt: new Date("2026-06-14T06:12:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "validate-ai-news-artifact",
        issueId: blockedIssue.id,
        status: "failed",
        startedAt: new Date("2026-06-14T06:12:00.000Z"),
        completedAt: new Date("2026-06-14T06:17:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: blockedIssue.id,
      type: "obsidian_note",
      provider: "local-filesystem",
      title: "20260614 Tech AI News Obsidian note",
      status: "ready_for_review",
      isPrimary: true,
      metadata: {
        artifactPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260614.md",
      },
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: blockedIssue.id,
      authorAgentId: workerAgentId,
      body: "REQUEST_CHANGES: regenerate the infographic before delivery; 3 hallucinated panels and 8 missing source articles remain.",
      createdAt: new Date("2026-06-14T06:18:00.000Z"),
      updatedAt: new Date("2026-06-14T06:18:00.000Z"),
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, missionId));
    const sourceIssue = missionIssues.find((issue) => issue.id === blockedIssue.id);
    const unblockIssues = missionIssues.filter((issue) => issue.originKind === "mission_main_executor_unblock");

    expect(sourceIssue).toEqual(expect.objectContaining({
      id: blockedIssue.id,
      assigneeAgentId: workerAgentId,
      status: "blocked",
    }));
    expect(unblockIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originId: blockedIssue.id,
        parentId: null,
        status: "todo",
        title: expect.stringContaining("Blocked delegated work"),
      }),
    ]);
    const description = unblockIssues[0]!.description ?? "";
    expect(description).toContain(`<!-- mission-owner-action:{"missionId":"${missionId}","sourceIssueId":"${blockedIssue.id}","actionType":"unblock","status":"decision_required"} -->`);
    expect(description).toContain(`Mission id: ${missionId}`);
    expect(description).toContain("Mission title: Blocked workflow mission");
    expect(description).toContain(`Source issue id: ${blockedIssue.id}`);
    expect(description).toContain(`Source issue identifier: ${blockedIssue.identifier}`);
    expect(description).toContain("Source issue title: Blocked delegated work");
    expect(description).toContain("Source issue status: blocked");
    expect(description).toContain(`Original assignee agent: ${workerAgentId}`);
    expect(description).toContain("Mission execution digest:");
    expect(description).toContain("- Mission description: Create the daily Tech AI News note, validate the artifact, then deliver it after approval.");
    expect(description).toContain(`- Workflow run: tech-ai-news (${workflowRunId}) status=failed`);
    expect(description).toContain("- Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped");
    expect(description).toContain("- Step validate-ai-news-artifact (Validate AI news artifact) status=failed");
    expect(description).toContain("- Step send-telegram (Send Telegram) status=skipped");
    expect(description).toContain("- Work product");
    expect(description).toContain("20260614 Tech AI News Obsidian note");
    expect(description).toContain("REQUEST_CHANGES: regenerate the infographic before delivery");
    expect(description).toContain("Mission-owner signal from oversight. This is a wakeup plus basic state/evidence; the main executor must judge and act to complete the mission.");
    expect(description).toContain("Main executor brief:");
    expect(description).toContain("- You own mission execution. Your goal is to complete the mission, not merely classify the alert.");
    expect(description).toContain("Mission goal: Blocked workflow mission");
    expect(description).toContain("Current situation: Source issue");
    expect(description).toContain("Main executor role:");
    expect(description).toContain("Mission execution loop:");
    expect(description).toContain("- Inspect the mission goal, plan, workflow/step state, issue tree, comments, work products, and run logs.");
    expect(description).toContain("- Choose and perform the action that best advances the mission: instruct or wake agents, request fixes, retry/resume bounded work, request/re-run tool steps, revalidate outputs, replan, escalate, or report impossible completion with evidence.");
    expect(description).toContain("Oversight signal boundary:");
    expect(description).toContain("- Treat this issue as a wakeup plus basic state/evidence from oversight. Oversight is not the recovery decision-maker.");
    expect(description).toContain("- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.");
    expect(description).toContain("- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.");
    for (const decision of [
      "request_input",
      "retry_source_issue",
      "reassign_source_issue",
      "replan_mission",
      "escalate",
      "report_impossible",
      "recover_artifact",
      "no_action_waiting",
    ]) {
      expect(description).toContain(decision);
    }
    expect(description).toContain("Decision authority (REQUIRED control path): submit your decision through the structured API, not a comment:");
    expect(description).toContain("POST /api/issues/{this owner-action issue id}/owner-recovery/decision");
    expect(description).toContain("Optional display-only comment template");
    expect(description).toContain("Comments (including any 'Decision:' block below) are DISPLAY-ONLY and can no longer drive recovery");
    expect(description).toContain("Source issue remains assigned to the original executor unless the structured decision is reassign_source_issue with targetAgentId.");
    expect(description).toContain("targetAgentId is REQUIRED");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({
        id: unblockIssues[0]?.id,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_unblock",
        status: "todo",
      }),
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, assigneeAgentId: workerAgentId }),
    }));

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 11 * 60 * 1000),
    });
    const repeatedUnblockIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedUnblockIssues).toHaveLength(1);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });
}
