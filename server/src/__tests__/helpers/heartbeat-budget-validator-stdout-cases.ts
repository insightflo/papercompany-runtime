import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatValidatorStdoutCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("does not block a succeeded mission validator run from REQUEST_CHANGES stdout alone or invent an owner unblock", async () => {
    const db = getDb();
    // Without an official workflow_validation_verdict ledger row, stdout REQUEST_CHANGES is not authority.
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
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
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Validate the delegated artifact." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan",
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-QA",
        title: "[QA] Validate artifact before delivery",
        status: "todo",
        assigneeAgentId: validatorAgentId,
        originKind: "research_director_plan_child",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        { id: "synthesize-ai-news-note", name: "Synthesize note", agentId: validatorAgentId, dependencies: [] },
        { id: "validate-ai-news-note", name: "Validate note", agentId: validatorAgentId, dependencies: ["synthesize-ai-news-note"] },
        { id: "send-telegram", name: "Send Telegram", agentId: ownerAgentId, dependencies: ["validate-ai-news-note"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId,
        stepId: "synthesize-ai-news-note",
        issueId: parentIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run?.agentId === validatorAgentId) {
        await onLog("stdout", "REQUEST_CHANGES\n- fix hallucinated label before Telegram delivery\n");
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, validatorIssueId));
        return {
          ...successfulAdapterResult(),
          resultJson: { result: "REQUEST_CHANGES\n- fix hallucinated label before Telegram delivery" },
        };
      }
      await onLog("stdout", "Mission owner received validation recovery action.\n");
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      validatorAgentId,
      "assignment",
      { taskKey: `issue:${validatorIssueId}`, issueId: validatorIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    // Agent marked done and stdout RC is not authority; remain done (or auto-complete path), not blocked by NL gate.
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, validatorIssueId));
    expect(updatedIssue?.status).not.toBe("blocked");
    expect(updatedIssue?.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
    expect(comments.some((comment) => comment.body.includes("validation gate"))).toBe(false);

    const ownerActions = await db.select().from(issues).where(eq(issues.originId, validatorIssueId));
    expect(ownerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")).toBe(false);
  });
}
