import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionIssueTreeCases(getDb: () => ReturnType<typeof createDb>) {
  it("rejects non-UUID mission ids before mission subresource queries", async () => {
    const db = getDb();
    const svc = missionService(db);

    await expect(svc.getById("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.getIssueTree("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.listWorkflowRuns("mission-1")).rejects.toMatchObject({ status: 400 });
  });

  it("returns mission-linked issues through getIssueTree", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const manualSubissueId = randomUUID();
    const manualGrandchildId = randomUUID();
    const otherCompanySubissueId = randomUUID();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Mission Company",
        issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Mission Company",
        issuePrefix: `OT${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
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
      title: "Ship Mission",
      status: "active",
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        missionId,
        title: "Root issue",
        status: "todo",
        priority: "high",
        identifier: "MS-1",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: rootIssueId,
        title: "Child issue",
        status: "in_progress",
        priority: "medium",
        identifier: "MS-2",
      },
      {
        id: manualSubissueId,
        companyId,
        missionId: null,
        parentId: childIssueId,
        title: "Manual child without direct mission link",
        status: "todo",
        priority: "medium",
        identifier: "MS-3",
      },
      {
        id: manualGrandchildId,
        companyId,
        missionId: null,
        parentId: manualSubissueId,
        title: "Manual grandchild without direct mission link",
        status: "blocked",
        priority: "low",
        identifier: "MS-4",
      },
      {
        id: otherCompanySubissueId,
        companyId: otherCompanyId,
        missionId: null,
        parentId: childIssueId,
        title: "Other company child must not leak",
        status: "todo",
        priority: "low",
        identifier: "OT-1",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result).toHaveLength(4);
    expect(result.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([rootIssueId, childIssueId, manualSubissueId, manualGrandchildId]),
    );
    expect(result.map((issue) => issue.id)).not.toContain(otherCompanySubissueId);
    expect(result.find((issue) => issue.id === childIssueId)?.parentId).toBe(rootIssueId);
    expect(result.find((issue) => issue.id === manualSubissueId)?.parentId).toBe(childIssueId);
    expect(result.find((issue) => issue.id === manualGrandchildId)?.parentId).toBe(manualSubissueId);
  });

  it("returns mission issue tree with issue groups while preserving real parent-child relations", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const actionIssueId = randomUUID();
    const actionChildIssueId = randomUUID();
    const qaIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Grouped Issue Tree Company",
      issuePrefix: `GT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Action Worker",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Validator",
        role: "qa",
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
      title: "Grouped Mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        title: "[PLAN] Grouped Mission",
        status: "done",
        priority: "medium",
        identifier: "GT-1",
      },
      {
        id: actionIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: workerAgentId,
        originKind: "mission_action",
        title: "[ACTION] Gather source evidence",
        status: "todo",
        priority: "medium",
        identifier: "GT-2",
      },
      {
        id: actionChildIssueId,
        companyId,
        missionId: null,
        parentId: actionIssueId,
        assigneeAgentId: workerAgentId,
        originKind: "mission_action",
        title: "[ACTION] Subtask for one source packet",
        status: "todo",
        priority: "medium",
        identifier: "GT-3",
      },
      {
        id: qaIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: qaAgentId,
        originKind: "mission_qa",
        title: "[QA] Verify action evidence",
        status: "todo",
        priority: "high",
        identifier: "GT-4",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        title: "[OVERSIGHT] Failure and closeout decisions",
        status: "todo",
        priority: "medium",
        identifier: "GT-5",
      },
    ]);

    const result = await missionService(db).getIssueTree(missionId);

    expect(result.find((issue) => issue.id === planIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "plan" }));
    expect(result.find((issue) => issue.id === actionIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "action" }));
    expect(result.find((issue) => issue.id === actionChildIssueId)).toEqual(expect.objectContaining({ parentId: actionIssueId, issueGroup: "action" }));
    expect(result.find((issue) => issue.id === qaIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "qa" }));
    expect(result.find((issue) => issue.id === oversightIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "oversight" }));
    const missionLevelSiblings = result.filter((issue) => issue.missionId === missionId && issue.parentId === null).map((issue) => issue.issueGroup).sort();
    expect(missionLevelSiblings).toEqual(["action", "oversight", "plan", "qa"]);
  });
}
