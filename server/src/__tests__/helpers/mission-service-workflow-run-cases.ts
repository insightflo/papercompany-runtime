import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionWorkflowRunCases(getDb: () => ReturnType<typeof createDb>) {
  it("returns mission-linked workflow runs with step runs", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();
    const workProductId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Company",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Workflow Mission",
      status: "active",
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Launch Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          type: "agent",
          agentId: "",
          agentName: "Workflow Owner",
          dependencies: [],
          toolNames: ["search-docs"],
          knowledgeBaseIds: ["kb-product"],
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Draft mission brief",
      status: "in_progress",
      priority: "high",
      identifier: "WF-11",
      assigneeAgentId: ownerAgentId,
    });

    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Mission brief",
      url: "file:///tmp/mission-brief.md",
      status: "ready_for_review",
      isPrimary: true,
      summary: "Brief draft produced by workflow step",
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        workflowName: "Launch Workflow",
      }),
    );
    expect(result[0]?.stepRuns).toEqual([
      expect.objectContaining({
        id: stepRunId,
        workflowRunId: runId,
        stepId: "draft",
        issueId,
      }),
    ]);
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "draft",
        name: "Draft",
        type: "agent",
        agentId: ownerAgentId,
        toolNames: ["search-docs"],
        knowledgeBaseIds: ["kb-product"],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "WF-11",
          title: "Draft mission brief",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
        workProducts: [
          expect.objectContaining({
            id: workProductId,
            title: "Mission brief",
            url: "file:///tmp/mission-brief.md",
            status: "ready_for_review",
            isPrimary: true,
            summary: "Brief draft produced by workflow step",
          }),
        ],
      }),
    ]);
    expect(result[0]?.progress).toEqual({
      totalSteps: 1,
      pendingSteps: 0,
      runningSteps: 1,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
    });
  });
}
