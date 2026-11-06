import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueComments, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatPlanDecisionAuthorityCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus, decisionComment, validOwnerPlanDecision }: HeartbeatBudgetCaseContext) {
  it("does not treat a PLAN decision comment as authority when heartbeat auto-completes the planning issue", async () => {
    const db = getDb();
    // Structured authority only: Markdown/JSON decision comments are display-only after 655e889.
    // Heartbeat may still complete the checked-out PLAN issue, but must not materialize plans/PAQO.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await db.insert(issueComments).values({
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: decisionComment(decision),
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    expect(comments.map((comment) => comment.body).join("\n")).toContain("### Mission owner plan decision");

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans.filter((candidate) => candidate.status === "active")).toHaveLength(0);

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(0);
    const missionRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(missionRuns).toHaveLength(0);
  });

  it("does not treat adapter-captured PLAN decision output as plan materialization authority", async () => {
    const db = getDb();
    // Captured PLAN decision comments may remain for display/audit, but stdout/comment JSON is
    // not control-plane authority and must not create active plans or PAQO workflows.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await onLog("stdout", `${JSON.stringify({
        type: "result",
        subtype: "success",
        result: `Planning complete.\n\n${decisionComment(decision)}\n\nSummary: proceed.`,
      })}\n`);
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    const commentBodies = comments.map((comment) => comment.body).join("\n\n");
    expect(commentBodies).toContain("### Captured PLAN decision output");
    expect(commentBodies).toContain("### Mission owner plan decision");

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans.filter((candidate) => candidate.status === "active")).toHaveLength(0);
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(0);
    const missionRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(missionRuns).toHaveLength(0);
  });
}
