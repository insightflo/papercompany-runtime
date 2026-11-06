import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missionPlanArtifacts, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionPlanningCases(getDb: () => ReturnType<typeof createDb>) {
  it("creates a main executor planning issue for a manual mission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const errorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Mission Company",
      issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Unavailable Worker",
        role: "researcher",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[PLAN] Customer homepage rollout",
      }),
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[OVERSIGHT] Customer homepage rollout",
      }),
    ]));
    expect(planningIssues).toHaveLength(2);
    const planningIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_plan");
    for (const expected of [
      "POST /api/issues/{planningIssueId}/mission-plan-decision",
      "use `graphWorkProductRequired: false` only for pure condition/input-check/QA units",
      "keep the upstream producer unit true when a downstream unit validates",
    ]) expect(planningIssue?.description).toContain(expected);
    expect(planningIssue?.description).toContain("A Markdown `### Mission owner plan decision` comment is display-only");
    expect(planningIssue?.description).not.toContain("Post exactly one structured `### Mission owner plan decision` JSON comment");
    expect(planningIssue?.description).toContain("\"assigneeAgentId\":\"agent-id-from-roster\"");
    expect(planningIssue?.description).toContain(`Main Executor (operator) id=${ownerAgentId} [mission owner]`);
    expect(planningIssue?.description).not.toContain(errorAgentId);
    expect(planningIssue?.description).not.toContain("Unavailable Worker");
  });

  it("creates an initial active mission plan artifact alongside the manual planning issue", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Plan Artifact Company",
      issuePrefix: `MA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ originKind: "mission_main_executor_plan" }),
      expect.objectContaining({ originKind: "mission_main_executor_oversight" }),
    ]));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        companyId,
        missionId: result.id,
        ownerAgentId,
        revision: 1,
        status: "active",
        missionGoal: expect.stringContaining("Customer homepage rollout"),
      }),
    ]);
    const planningIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_plan");
    const oversightIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_oversight");
    expect(planArtifacts[0]?.refs).toEqual(expect.objectContaining({
      planningIssueId: planningIssue?.id,
      oversightIssueId: oversightIssue?.id,
    }));
    expect(result.activeMissionPlan).toEqual(
      expect.objectContaining({
        available: true,
        missionPlanId: planArtifacts[0]?.id,
        revision: 1,
        status: "active",
        stepCount: 4,
        executionUnitCount: 0,
      }),
    );
    expect(planArtifacts[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "plan-skeleton", title: expect.stringContaining("source, synthesis, and QA") }),
      expect.objectContaining({ id: "qa-after-artifact", title: expect.stringContaining("Run QA only after") }),
    ]));
    expect(planArtifacts[0]?.successCriteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: expect.stringContaining("QA or validation work starts only after") }),
    ]));
  });

  it("treats non-workflow mission sources as manual launches", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Board Source Mission Company",
      issuePrefix: `BS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Board-created active mission",
      description: "Created from the board UI.",
      status: "active",
      // @ts-expect-error Deliberately invalid source: statically rejected, tolerated as manual at runtime.
      source: "board",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[PLAN] Board-created active mission",
      }),
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[OVERSIGHT] Board-created active mission",
      }),
    ]));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        missionId: result.id,
        revision: 1,
        status: "active",
      }),
    ]);
    expect(result.activeMissionPlan).toEqual(expect.objectContaining({
      available: true,
      stepCount: 4,
    }));
  });
}
