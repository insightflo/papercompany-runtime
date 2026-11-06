import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

export function registerMissionToolRecoveryClassificationCases(getDb: () => ReturnType<typeof createDb>) {
  it("classifies issue-less tool recovery from captured runtime evidence before step metadata heuristics", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-12T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Missing File Recovery Company",
      issuePrefix: `MF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Missing file recovery mission",
      status: "active",
    }).returning();

    const svc = missionService(db);
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-macro-sentinel", {
      sourceRunId: runId,
      workflowStepIds: ["scan"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-macro-sentinel",
      stepsJson: [
        {
          id: "scan",
          name: "Macro event scan",
          type: "tool",
          dependencies: [],
          toolNames: ["collect-macro"],
          description: "Scan macro signals from external sources.",
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
      startedAt: new Date("2026-06-12T06:00:26.096Z"),
      completedAt: new Date("2026-06-12T06:00:26.323Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "scan",
      issueId: null,
      status: "failed",
      startedAt: new Date("2026-06-12T06:00:26.106Z"),
      completedAt: new Date("2026-06-12T06:00:26.302Z"),
      metadata: {
        toolResult: {
          toolName: "collect-macro",
          success: false,
          exitCode: 2,
          error: "Command failed: python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode macro",
          stdout: "",
          stderr: "/Users/kwak/.pyenv/versions/3.11.6/bin/python3: can't open file '/Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py': [Errno 2] No such file or directory",
        },
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("class=missing_file"),
    ]));
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows.find((issue) => issue.originId === oversightIssue.id)!);
    expect(recoveryIssue).toEqual(expect.objectContaining({
      assigneeAgentId: ownerAgentId,
      status: "todo",
      title: "[Owner Action] Tool step failed: scan",
    }));
    expect(recoveryIssue.description).toContain(`<!-- tool-step-recovery:${runId}:scan -->`);
    expect(recoveryIssue.description).toContain("Local signal hint: missing_file");
    expect(recoveryIssue.description).not.toContain("Local retry hint:");
    expect(recoveryIssue.description).toContain("can't open file");
    expect(recoveryIssue.description).toContain("No such file or directory");
    expect(recoveryIssue.description).toContain("No recovery action has been selected by automation.");
  });

  it("does not retry or close duplicate tool cards from completed status and description markers alone", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const failedStepRunId = randomUUID();
    const downstreamStepRunId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    const now = new Date("2026-06-10T07:30:00.000Z");

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Auto Recovery Company",
      issuePrefix: `TA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Tool step auto recovery mission",
      status: "active",
    }).returning();

    const svc = missionService(db);
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["collect-signals", "signal-analysis"],
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
        {
          id: "signal-analysis",
          name: "Analyze signals",
          type: "tool",
          dependencies: ["collect-signals"],
          toolNames: ["analyze-signals"],
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
    await db.insert(workflowStepRuns).values([
      {
        id: failedStepRunId,
        workflowRunId: runId,
        stepId: "collect-signals",
        issueId: null,
        status: "failed",
        startedAt: new Date("2026-06-10T06:21:11.582Z"),
        completedAt: new Date("2026-06-10T06:23:53.691Z"),
      },
      {
        id: downstreamStepRunId,
        workflowRunId: runId,
        stepId: "signal-analysis",
        issueId: null,
        status: "skipped",
        startedAt: null,
        completedAt: new Date("2026-06-10T06:23:53.691Z"),
      },
    ]);

    const discovery = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now });
    expect(discovery.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
    ]));
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]!);
    expect(recoveryIssue.description).toContain(`<!-- tool-step-recovery:${runId}:collect-signals -->`);
    const duplicateRecoveryIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      description: recoveryIssue.description,
      missionId,
      originKind: "mission_main_executor_unblock",
      originId: oversightIssue.id,
      priority: "high",
      status: "todo",
      title: "[Owner Action] Tool step failed: collect-signals duplicate",
    });

    await issueService(db).update(recoveryIssue.id, { status: "done" });

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-10T07:35:00.000Z"),
      applyOwnerDecisionActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.appliedActions).toEqual([]);
    expect(result.missions[0]?.recoveryOutcomes).toContainEqual(expect.objectContaining({
      ownerActionIssueId: recoveryIssue.id, kind: "no_op", outcome: "blocked", reason: "legacy_source_observation_only",
    }));
    const [runAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(runAfter?.status).toBe("failed");
    const stepRunsAfter = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRunsAfter.find((step) => step.id === failedStepRunId)?.status).toBe("failed");
    expect(stepRunsAfter.find((step) => step.id === downstreamStepRunId)?.status).toBe("skipped");
    expect(await processQueuedWorkflowToolStepRuns(db)).toMatchObject({ claimedCount: 0, executedCount: 0 });
    expect(executeToolStep).not.toHaveBeenCalled();
    const [duplicateAfter] = await db.select().from(issues).where(eq(issues.id, duplicateRecoveryIssue.id));
    expect(duplicateAfter?.status).toBe("todo");
  });
}
