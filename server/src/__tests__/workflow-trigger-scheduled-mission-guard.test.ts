import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowRunSlots,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: heartbeatWakeup,
  }),
}));

import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow trigger guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function seedScheduledWorkflow(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const workflowId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Scheduled Workflow Guard Company",
    issuePrefix: `SWG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    timezone: "Asia/Seoul",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Scheduled Agent",
    role: "researcher",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "Tech daily scheduled workflow",
    status: "active",
    schedule: "0 6 * * *",
    timezone: "Asia/Seoul",
    stepsJson: [
      {
        id: "collect",
        name: "Collect",
        agentId,
        dependencies: [],
      },
    ],
  });

  return { companyId, agentId, workflowId };
}

describeEmbeddedPostgres("workflow trigger scheduled mission guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-trigger-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowRunSlots);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects an implicit manual/agent run when the cron run already owns that workflow-date mission", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "heartbeat-run-1" });
    const { companyId, workflowId } = await seedScheduledWorkflow(db);

    const scheduled = await workflowService.claimScheduledRun(db, {
      workflowId,
      companyId,
      triggeredBy: "scheduler",
      triggerSource: "schedule",
      scheduledAt: new Date("2026-06-15T21:00:00.000Z"),
      runDate: "2026-06-16",
      timezone: "Asia/Seoul",
    });

    expect(scheduled.claimed).toBe(true);
    expect(scheduled.run?.missionId).toBeTruthy();

    await expect(workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "agent",
      runDate: "2026-06-16",
    })).rejects.toThrow(/already has scheduled workflow run/);

    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toEqual(expect.objectContaining({
      id: scheduled.run?.runId,
      triggerSource: "schedule",
      runDate: "2026-06-16",
    }));
  });
});
