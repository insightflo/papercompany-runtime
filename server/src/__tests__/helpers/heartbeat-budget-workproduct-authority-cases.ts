import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, documents, issueComments, issueDocuments, issueWorkProducts, issues, missions, projects } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatWorkProductAuthorityCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("does not auto-register a workProduct from a generic issue work-product document alone", async () => {
    const db = getDb();
    // Generic issueDocuments/documents are not Workflow API registration authority. Fail closed:
    // no auto-registration; missing durable issueWorkProducts blocks completion.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const outputPath = "/Users/kwak/Personal/obsidian/600. Improvements/602.Tech/202606/20260610.md";

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
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-SYN",
      title: "tech-scout: 기존 양식으로 Tech Scout 노트 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", `Output: ${outputPath}\n`);
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Tech Scout — 2026-06-10 TrendShift Top25",
        format: "markdown",
        latestBody: `Work product: ${outputPath}`,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "work-product",
      });
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
  });

  it("does not auto-register an ARTIFACT path marker from stdout for a workflow collect step", async () => {
    const db = getDb();
    // Deliverable-output contracts still require durable issueWorkProducts. [ARTIFACT] stdout is not authority.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";
    const outputDir = `${workProductRoot}/missions/${missionId}/runs/${workflowRunId}/steps/collect-tech-scout-evidence`;
    const artifactPath = `${outputDir}/evidence.json`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Technology Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Collect the required evidence and write the declared artifact." },
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
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-COLLECT",
      title: "Collect TrendShift Top25 evidence",
      description: [
        "Deliverable output (use exactly this directory):",
        `- ${outputDir}`,
        "- Write your deliverable file(s) into that directory.",
        "- Then finish your run output with one line: [ARTIFACT]: <absolute path of the file you wrote there>.",
      ].join("\n"),
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", [
        "Collected TrendShift evidence.",
        `[ARTIFACT]: ${artifactPath}`,
      ].join("\n"));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
  });
}
