import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, heartbeatRuns, workflowTransitionEvents, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.ts";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatVerdictLedgerCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("blocks workflow validator done when a succeeded run leaves no verdict ledger", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const validatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Validate the delegated artifact." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "qa-ledger-workflow",
      stepsJson: [
        { id: "validate-ai-news-note", name: "Validate note", agentId: validatorAgentId, dependencies: [] },
        { id: "send-telegram", name: "Send Telegram", agentId: validatorAgentId, dependencies: ["validate-ai-news-note"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      identifier: "PAP-QA",
      title: "[QA] Validate note",
      status: "todo",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: workflowRunId,
      originRunId: workflowRunId,
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId: "validate-ai-news-note",
      issueId: validatorIssueId,
      status: "running",
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });

    executeSpy.mockImplementation(async () => {
      await db
        .update(issues)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, validatorIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "Validation finished. No explicit verdict." },
      };
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

    const updatedIssue = await waitForIssueStatus(
      db,
      validatorIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("workflow_validation_verdict_missing"))).toBe(true);

    const events = await db
      .select()
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(events).toHaveLength(0);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.workflow_validation_verdict_missing_auto_blocked",
        entityId: validatorIssueId,
      }),
    ]));
  });

  it("blocks workflow validator done with the insufficient_evidence reason when the latest verdict abstains", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const validatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Validate the delegated artifact." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "qa-ledger-workflow",
      stepsJson: [
        { id: "validate-ai-news-note", name: "Validate note", agentId: validatorAgentId, dependencies: [] },
        { id: "send-telegram", name: "Send Telegram", agentId: validatorAgentId, dependencies: ["validate-ai-news-note"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      identifier: "PAP-QA",
      title: "[QA] Validate note",
      status: "todo",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: workflowRunId,
      originRunId: workflowRunId,
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId: "validate-ai-news-note",
      issueId: validatorIssueId,
      status: "running",
      startedAt: new Date("2026-07-05T03:38:00.000Z"),
    });

    executeSpy.mockImplementation(async () => {
      // QA agent cannot judge: submits the official insufficient_evidence verdict from THIS run.
      const [currentRun] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, validatorAgentId),
          eq(heartbeatRuns.issueId, validatorIssueId),
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      const [issueRow] = await db.select().from(issues).where(eq(issues.id, validatorIssueId));
      await recordWorkflowValidationVerdict({
        db,
        issue: issueRow!,
        verdict: "insufficient_evidence",
        source: "workflow_api",
        heartbeatRunId: currentRun!.id,
        sourceText: "Registered source dataset is missing; cannot judge accuracy claims.",
      });
      await db
        .update(issues)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, validatorIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "Validation cannot proceed without the source dataset." },
      };
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

    const updatedIssue = await waitForIssueStatus(
      db,
      validatorIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("workflow_validation_insufficient_evidence"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Registered source dataset is missing"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("workflow_validation_verdict_missing"))).toBe(false);

    const events = await db
      .select()
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0]?.verdict).toBe("insufficient_evidence");

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.workflow_validation_insufficient_evidence_blocked",
        entityId: validatorIssueId,
      }),
    ]));
    expect(activities.some((activity) => activity.action === "issue.workflow_validation_verdict_missing_auto_blocked")).toBe(false);
  });
}
