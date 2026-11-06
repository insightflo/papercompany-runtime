import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issues, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionSourceCases(getDb: () => ReturnType<typeof createDb>) {
  it("dispatches a one-shot owner planning wakeup for a manual mission without rolling back on dispatch failure", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Wakeup Company",
      issuePrefix: `PW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    const onOwnerPlanningIssueCreated = vi.fn(async () => {
      throw new Error("queue temporarily unavailable");
    });

    const result = await missionService(db, { onOwnerPlanningIssueCreated }).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id))
      .then((rows) => rows.find((issue) => issue.originKind === "mission_main_executor_plan") ?? null);

    expect(planningIssue).toEqual(expect.objectContaining({
      assigneeAgentId: ownerAgentId,
      status: "todo",
    }));
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledOnce();
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledWith({
      mission: expect.objectContaining({ id: result.id, companyId, ownerAgentId }),
      issue: expect.objectContaining({ id: planningIssue?.id, originKind: "mission_main_executor_plan" }),
      targetAgentId: ownerAgentId,
      idempotencyKey: `mission-owner-planning-wakeup:${result.id}:${planningIssue?.id}`,
    });
  });

  it("does not create a manual planning issue for a workflow-created mission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Company",
      issuePrefix: `WM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "active",
      source: "workflow",
    });

    const workflowIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(workflowIssues).toEqual([
      expect.objectContaining({
        originKind: "mission_main_executor_oversight",
        title: "[OVERSIGHT] 2026-04-28 gazua-morning",
      }),
    ]);
    expect(workflowIssues.some((issue) => issue.originKind === "mission_main_executor_plan")).toBe(false);
  });
}
