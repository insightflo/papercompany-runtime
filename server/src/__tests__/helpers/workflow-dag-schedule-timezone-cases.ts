import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowRuns, type createDb } from "@paperclipai/db";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagScheduleTimezoneCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("uses workflow/company timezone, not UTC, for scheduled runDate and mission titles", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-timezone-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "KST Workflow Company",
      issuePrefix: `KST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "KST Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-morning",
      timezone: null,
      steps: [
        {
          id: "collect-market",
          name: "Collect market",
          agentId,
          dependencies: [],
        },
      ],
    });

    const result = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-11T22:30:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(result.claimed).toBe(true);

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.run!.runId))
      .limit(1);
    expect(run?.runDate).toBe("2026-06-12");

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);

    expect(mission?.title).toBe("2026-06-12 gazua-morning");
  });

  it("does not start another scheduled run that would duplicate issues in the same active workflow mission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-scheduled-active-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Active Scheduled Mission Company",
      issuePrefix: `ASM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-macro-sentinel",
      timezone: "Asia/Seoul",
      schedule: "0 9-15 * * 1-5",
      steps: [
        {
          id: "report",
          name: "초보자용 매크로 리포트 생성",
          agentId,
          dependencies: [],
        },
      ],
    });

    const first = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T00:00:00.000Z"),
      timezone: "Asia/Seoul",
    });
    expect(first.claimed).toBe(true);

    const second = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T01:00:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(second.claimed).toBe(false);
    expect(second.run).toBeNull();

    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, definition.id));
    expect(storedRuns).toHaveLength(1);

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, storedRuns[0]!.missionId!))
      .limit(1);
    expect(mission?.status).toBe("active");

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, mission!.id));
    expect(missionIssues.filter((issue) => issue.title === "초보자용 매크로 리포트 생성")).toHaveLength(1);
  });
}
