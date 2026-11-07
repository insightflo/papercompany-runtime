import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueComments, issueWorkProducts, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatWorkProductPathClaimsCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("does not block when an active primary workProduct exists even if stdout names a different file", async () => {
    const db = getDb();
    // With structured authority, empty claimed-path matching: an active primary issueWorkProduct is enough.
    // stdout filename claims are not authority and must not force a mismatch block.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Technology Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "HTML 학습 자료를 작성하고 workProduct로 등록하세요." },
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
      identifier: "PAP-HTML",
      title: "[ACTION] 초보자용 에이전틱 RAG HTML 학습 자료 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      const outputPath = "/Users/kwak/Downloads/google_agentic_rag_for_beginners.html";
      await onLog("stdout", `Deliverable: ${outputPath}\n`);
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "document",
        provider: "local",
        title: "초보자용 에이전틱 RAG HTML 학습 자료",
        status: "active",
        isPrimary: true,
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
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  it("does not block when a registered workProduct satisfies the issue-declared artifact despite unrelated logged paths", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const declaredOutputPath = "/Users/kwak/Projects/ai/gazua-dashboard/reports/deep_dive/202606/Sector_Rotation_Analysis_2026-06-14.md";
    const unrelatedLoggedPath = "/ai/gazua-dashboard/reports/daily/202606/KR_Market_Report_2026-06-14.md";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sector Rotation Analyst",
      role: "analyst",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "작성한 리포트를 workProduct로 등록하세요." },
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
      identifier: "PAP-SECTOR",
      title: "gazua-morning: 섹터 로테이션 리포트 작성",
      description: [
        "섹터 로테이션 분석 리포트를 작성한다.",
        "출력 파일:",
        "- reports/deep_dive/YYYYMM/Sector_Rotation_Analysis_YYYY-MM-DD.md",
      ].join("\n"),
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
        title: "Sector Rotation Analysis 2026-06-14",
        status: "active",
        isPrimary: true,
        metadata: { path: declaredOutputPath },
      });
      await onLog("stdout", `Daily report path: ${unrelatedLoggedPath}\n`);
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: unrelatedLoggedPath },
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

  it("does not apply missing workProduct registration gate to lead approval issues", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Director",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Approve the already registered artifacts." },
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
      identifier: "PAP-LEAD",
      title: "tech-ai-news: Lead approval for TechCrunch AI note",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Approved existing artifact path: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md\n");
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "Lead approval: APPROVED. Existing artifact path reviewed." },
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
    expect(updatedIssue.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });
}
