import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missionService } from "../services/missions.js";
import { createMissionWorkSettlement } from "../services/missions/mission-work-settlement.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping stale unblock settlement test: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("mission stale unblock settlement", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-settlement-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("completes a finished workflow mission when a blocked unblock action only references a done source", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const unblockIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const completedAt = new Date("2026-07-11T03:02:53.057Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Resolved Owner Action Company",
      issuePrefix: `RO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Completed workflow with stale unblock",
      status: "active",
      startedAt: new Date("2026-07-11T02:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        missionId,
        title: "Published report",
        status: "done",
        originKind: "workflow_execution",
        completedAt,
      },
      {
        id: unblockIssueId,
        companyId,
        missionId,
        title: "[Unblock] Published report",
        status: "blocked",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Completed workflow with stale unblock",
        status: "todo",
        originKind: "mission_main_executor_oversight",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "stale-unblock-workflow",
      stepsJson: [{ id: "publish", name: "Publish", agentId: ownerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "completed",
      triggeredBy: "test",
      startedAt: new Date("2026-07-11T02:00:00.000Z"),
      completedAt,
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "publish",
      issueId: sourceIssueId,
      status: "completed",
      startedAt: new Date("2026-07-11T02:30:00.000Z"),
      completedAt,
    });

    const detail = await missionService(db).getById(missionId);
    const [source, unblock, oversight] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, unblockIssueId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, oversightIssueId)).then((rows) => rows[0]),
    ]);

    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(completedAt);
    expect(source?.status).toBe("done");
    expect(unblock?.status).toBe("done");
    expect(unblock?.completedAt).toEqual(completedAt);
    expect(oversight?.status).toBe("done");
    expect(oversight?.completedAt).toEqual(completedAt);
  });

  it("settles only inactive unblock actions whose sources are terminal", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const unblockIssueId = randomUUID();
    const realWorkIssueId = randomUUID();
    const cancelledSourceIssueId = randomUUID();
    const cancelledUnblockIssueId = randomUUID();
    const doneAt = new Date("2026-07-11T04:00:00.000Z");
    const cancelledAt = new Date("2026-07-11T04:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Unresolved Owner Action Company",
      issuePrefix: `UO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Unresolved Mission Owner",
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
      title: "Workflow with unresolved unblock",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        missionId,
        title: "Blocked report",
        status: "blocked",
        originKind: "workflow_execution",
      },
      {
        id: unblockIssueId,
        companyId,
        missionId,
        title: "[Unblock] Blocked report",
        status: "blocked",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
      },
    ]);

    const findOpenMissionWork = createMissionWorkSettlement(db);
    let openWork = await findOpenMissionWork(companyId, missionId);
    let [unblock] = await db.select().from(issues).where(eq(issues.id, unblockIssueId));

    expect(openWork?.status).toBe("blocked");
    expect([sourceIssueId, unblockIssueId]).toContain(openWork?.id);
    expect(unblock?.status).toBe("blocked");
    expect(unblock?.completedAt).toBeNull();

    await db.update(issues).set({ status: "done", completedAt: doneAt }).where(eq(issues.id, sourceIssueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, unblockIssueId));
    openWork = await findOpenMissionWork(companyId, missionId);
    [unblock] = await db.select().from(issues).where(eq(issues.id, unblockIssueId));
    expect(openWork).toEqual({ id: unblockIssueId, status: "in_progress" });
    expect(unblock?.status).toBe("in_progress");

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, unblockIssueId));
    await db.insert(issues).values({
      id: realWorkIssueId,
      companyId,
      missionId,
      title: "Still-open delivery work",
      status: "todo",
      originKind: "workflow_execution",
    });
    openWork = await findOpenMissionWork(companyId, missionId);
    [unblock] = await db.select().from(issues).where(eq(issues.id, unblockIssueId));
    expect(openWork).toEqual({ id: realWorkIssueId, status: "todo" });
    expect(unblock?.status).toBe("done");
    expect(unblock?.completedAt).toEqual(doneAt);

    await db.insert(issues).values([
      {
        id: cancelledSourceIssueId,
        companyId,
        missionId,
        title: "Cancelled source work",
        status: "cancelled",
        cancelledAt,
      },
      {
        id: cancelledUnblockIssueId,
        companyId,
        missionId,
        title: "[Unblock] Cancelled source work",
        status: "blocked",
        originKind: "mission_main_executor_unblock",
        originId: cancelledSourceIssueId,
      },
    ]);
    openWork = await findOpenMissionWork(companyId, missionId);
    const [cancelledUnblock] = await db.select().from(issues).where(eq(issues.id, cancelledUnblockIssueId));
    expect(openWork).toEqual({ id: realWorkIssueId, status: "todo" });
    expect(cancelledUnblock?.status).toBe("cancelled");
    expect(cancelledUnblock?.cancelledAt).toEqual(cancelledAt);
  });
});
