import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagValidatorRequeueCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  it("queues a blocked validator issue when an upstream dependency completes after REQUEST_CHANGES", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const synthAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const synthIssueId = randomUUID();
    const validatorIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-validator-recheck" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recheck",
      issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: synthAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
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
      title: "Daily AI news validator recheck",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "synthesize-ai-news-note",
          name: "Synthesize TechCrunch AI note draft",
          agentId: synthAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: ["synthesize-ai-news-note"],
        },
        {
          id: "lead-ai-news-approval",
          name: "Lead approval for TechCrunch AI note",
          agentId: ownerAgentId,
          dependencies: ["validate-ai-news-note"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-18T05:06:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: synthIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Synthesize TechCrunch AI note draft",
        status: "done",
        assigneeAgentId: synthAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
        status: "blocked",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
      },
    ]);
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "synthesize-ai-news-note",
        issueId: synthIssueId,
        status: "completed",
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
        completedAt: new Date("2026-06-18T05:37:09.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "lead-ai-news-approval",
        issueId: null,
        status: "pending",
      },
    ]);
    await recordWorkflowVerdictForIssue(
      validatorIssueId,
      "request_changes",
      "2026-06-18T05:37:09.000Z",
      "REQUEST_CHANGES: Three source-bound fidelity fixes are required on the synthesis issue.",
    );

    const result = await syncWorkflowRunForIssue(db, synthIssueId);

    expect(result?.status).toBe("running");
    const [validatorIssue] = await db.select().from(issues).where(eq(issues.id, validatorIssueId));
    expect(validatorIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: validatorAgentId,
    });
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")).toMatchObject({
      status: "failed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "lead-ai-news-approval")).toMatchObject({
      status: "pending",
      issueId: null,
    });
    expect(heartbeatWakeup).toHaveBeenCalledWith(validatorAgentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: validatorIssueId,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId: "validate-ai-news-note",
        workflowStepRunId: expect.any(String),
      }),
    }));
  });
}
