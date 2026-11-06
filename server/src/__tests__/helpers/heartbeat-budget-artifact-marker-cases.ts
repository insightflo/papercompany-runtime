import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueComments, issueWorkProducts, issues, missions, projects } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatArtifactMarkerCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("does not auto-register an ARTIFACT path marker when a recovery run succeeds with a stale todo lifecycle", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";
    const outputDir = `${workProductRoot}/missions/${missionId}/runs/${workflowRunId}/steps/reuse-existing-research`;
    const artifactPath = `${outputDir}/feynman-methodology-storm-research.md`;

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
      adapterConfig: { promptTemplate: "Reuse the existing artifact and emit its ARTIFACT line." },
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
      identifier: "PAP-REUSE",
      title: "[ACTION] Reuse existing research artifact",
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
        "Existing deliverable verified; re-emitting the registered artifact marker.",
        `[ARTIFACT]: ${artifactPath}`,
      ].join("\n"));
      await db
        .update(issues)
        .set({
          status: "todo",
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));
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

  it("ignores prompt and instruction paths when checking registered workProducts", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const outputPath = "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/deep_dive/202606/Narrative_Deep_Dive_2026-06-12_US.html";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Writer",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required report and register workProducts." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Gazua report mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-HTML",
      title: "gazua-evening: report-for-beginners HTML 패키지 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "document",
        provider: "local",
        title: "Narrative Deep Dive 2026-06-12 US",
        status: "active",
        isPrimary: true,
        metadata: { path: outputPath },
      });
      await onLog(
        "stdout",
        [
          "=== Narrative_Deep_Dive_2026-06-12_US.html ===",
          "/table: 4\\nkpi-grid: 2\\nrisk-grid: 2\\nscenario-grid: 2\\nreferences: 4",
          "/srv/papercompany/company-skills/report-for-beginners/SKILL.md",
          "/Users/kwak/Projects/ai/papercompany/papercompany-operations/scripts/paperclip-addon/agents/gazua/harry.md",
          "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/deep_dive/YYYYMM/Narrative_Deep_Dive_2026-06-12_US.html",
        ].join("\n"),
      );
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "3 workProducts registered and verified." },
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
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });
}
