import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import { agentRuntimeState, agents, companies, companySecrets, heartbeatRuns, issues, missionPlanArtifacts, missionSessions, missions, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionReopenCases(getDb: () => ReturnType<typeof createDb>) {
  it("reopens a completed workflow mission so oversight can recover remaining blocked work", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const blockedIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Recovery Company",
      issuePrefix: `MR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
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
      title: "Workflow mission with unresolved work",
      description: "Created automatically for workflow run: recovery-workflow",
      status: "completed",
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        missionId,
        title: "Blocked producer",
        status: "blocked",
        priority: "medium",
        originKind: "workflow_execution",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Workflow mission with unresolved work",
        status: "done",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
        completedAt: new Date("2026-06-09T04:41:12.533Z"),
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Recovery workflow",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "completed",
      triggeredBy: "test",
      startedAt: new Date("2026-06-09T04:00:00.000Z"),
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });

    const detail = await missionService(db).reconcileById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();
    expect(oversight?.status).toBe("todo");
    expect(oversight?.completedAt).toBeNull();

    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Workflow Company",
      issuePrefix: `FW${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, blockedIssueId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, oversightIssueId));
    await db.update(missions).set({ status: "completed", completedAt: new Date() }).where(eq(missions.id, missionId));
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: foreignCompanyId,
      missionId,
      title: "Foreign blocked issue with invalid mission linkage",
      status: "blocked",
      priority: "medium",
      originKind: "workflow_execution",
    });

    const settledDetail = await missionService(db).reconcileById(missionId);
    expect(settledDetail.status).toBe("completed");
  });

  it("cleans up mission runtime state when a mission is cancelled", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const secretId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Cancel Cleanup Company",
      issuePrefix: `CC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "ceo",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Mission Worker",
        role: "researcher",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(agentRuntimeState).values([
      {
        agentId: ownerAgentId,
        companyId,
        adapterType: "codex_local",
        sessionId: "owner-session",
        stateJson: {},
        lastRunStatus: "failed",
        lastError: "owner failed",
      },
      {
        agentId: workerAgentId,
        companyId,
        adapterType: "codex_local",
        sessionId: "worker-session",
        stateJson: {},
        lastRunStatus: "failed",
        lastError: "worker failed",
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Cancelable mission",
      status: "active",
    });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Clean up cancelled mission state",
      refs: {},
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      name: "mission-session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId: ownerAgentId,
      companyId,
      sessionSecretId: secretId,
      adapterType: "codex_local",
      status: "active",
      runCount: 1,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Open mission work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: workerAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerAgentId,
      issueId,
      invocationSource: "targeted_wakeup",
      status: "running",
      contextSnapshot: {},
    });

    const detail = await missionService(db).update(missionId, { status: "cancelled" });

    expect(detail.status).toBe("cancelled");
    expect(detail.activeMissionPlan.available).toBe(false);
    expect(detail.sessionBindings).toEqual([
      expect.objectContaining({ agentId: ownerAgentId, status: "closed" }),
    ]);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const agentRows = await db.select().from(agents).where(inArray(agents.id, [ownerAgentId, workerAgentId]));
    const runtimeRows = await db
      .select()
      .from(agentRuntimeState)
      .where(inArray(agentRuntimeState.agentId, [ownerAgentId, workerAgentId]));

    expect(issue?.status).toBe("cancelled");
    expect(issue?.cancelledAt).toBeTruthy();
    expect(run).toEqual(expect.objectContaining({
      status: "cancelled",
      errorCode: "cancelled",
    }));
    expect(agentRows.map((agent) => [agent.id, agent.status]).sort()).toEqual([
      [ownerAgentId, "idle"],
      [workerAgentId, "idle"],
    ].sort());
    expect(runtimeRows).toHaveLength(2);
    for (const row of runtimeRows) {
      expect(row.lastError).toBeNull();
      expect(row.sessionId).toBeNull();
    }
  });

}
