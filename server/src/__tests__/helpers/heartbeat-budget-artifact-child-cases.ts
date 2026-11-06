import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueComments, issueWorkProducts, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatArtifactChildCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("blocks an artifact-producing mission child run when no workProduct is registered", async () => {
    const db = getDb();
    // Gate still requires a durable issueWorkProducts row; stdout path text is not registration authority.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthesis Editor",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required artifact and register it as a workProduct." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
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
        assigneeAgentId: agentId,
        originKind: "research_director_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SYN",
        title: "[Synthesis] Draft note artifact",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Output: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260608.md\n");
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260608.md" },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      completedAt: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
    // claimed stdout paths are not authority and must not be echoed as registration claims.
    expect(comments.some((comment) => comment.body.includes("20260608.md"))).toBe(false);
  });

  it("blocks missing workProduct registration even when the agent marks the issue done before run finalization", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthesis Editor",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required artifact and register it as a workProduct." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      missionId,
      identifier: "PAP-SYN",
      title: "[Synthesis] Draft note artifact",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Output: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md\n");
      await db
        .update(issues)
        .set({
          status: "done",
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, childIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md" },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("20260609.md"))).toBe(false);
  });
}
