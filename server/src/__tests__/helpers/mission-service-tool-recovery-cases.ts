import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionToolRecoveryCases(getDb: () => ReturnType<typeof createDb>) {
  it("creates and wakes a main-executor recovery issue for failed issue-less tool steps", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-10T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Recovery Company",
      issuePrefix: `TR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tool step recovery mission",
      status: "active",
    }).returning();

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["collect-signals"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [
        {
          id: "collect-signals",
          name: "Collect KR signals",
          type: "tool",
          dependencies: [],
          toolNames: ["collect-signals-kr"],
          description: "Collect market signals via external HTTP sources.",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: new Date("2026-06-10T06:21:11.582Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "collect-signals",
      issueId: null,
      status: "failed",
      startedAt: new Date("2026-06-10T06:21:11.582Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
      expect.stringContaining("recovery_issue_created"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        workflowRunId: runId,
        stepId: "collect-signals",
        safeToAutoApply: false,
      }),
    ]));

    const ownerActionIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActionIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        missionId,
        originId: oversightIssue.id,
        parentId: oversightIssue.id,
        status: "todo",
        title: "[Owner Action] Tool step failed: collect-signals",
      }),
    ]);
    expect(ownerActionIssues[0]?.description).toContain(`<!-- tool-step-recovery:${runId}:collect-signals -->`);
    expect(ownerActionIssues[0]?.description).toContain("Tool names: collect-signals-kr");
    expect(ownerActionIssues[0]?.description).toContain("Local signal hint: transient_or_external");
    expect(ownerActionIssues[0]?.description).not.toContain("Local retry hint:");
    expect(ownerActionIssues[0]?.description).toContain("Main executor brief:");
    expect(ownerActionIssues[0]?.description).toContain("Mission: Tool step recovery mission");
    expect(ownerActionIssues[0]?.description).toContain("Structured system facts");
    expect(ownerActionIssues[0]?.description).toContain("registration_not_applicable");
    expect(ownerActionIssues[0]?.description).toContain("does not automatically retry or complete a tool");
    expect(ownerActionIssues[0]?.description).toContain("No classification selects the next action");

    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({ id: ownerActionIssues[0]?.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: oversightIssue.id }),
      reason: "tool_step_failure_recovery_created",
    }));

    const repeated = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-06-10T06:35:00.000Z") });
    expect(repeated.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("recovery_issue_exists"),
    ]));
    const repeatedOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedOwnerActions).toHaveLength(1);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });

  it("does not create tool recovery issues for unlaunched failed issue-less tool steps", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-10T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Unlaunched Tool Step Company",
      issuePrefix: `UT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Unlaunched tool step mission",
      status: "active",
    }).returning();

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["sync-dashboard"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          type: "tool",
          dependencies: ["inspection"],
          toolNames: ["gazua.oracle-data-sync"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: new Date("2026-06-10T06:00:00.000Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "sync-dashboard",
      issueId: null,
      status: "failed",
      startedAt: null,
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
      metadata: { graphWorkProductRequired: false },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failure_unlaunched_skipped"),
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
    ]));
    expect(result.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", workflowRunId: runId, stepId: "sync-dashboard" }),
    ]));
    const ownerActionIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActionIssues).toHaveLength(0);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
  });
}
