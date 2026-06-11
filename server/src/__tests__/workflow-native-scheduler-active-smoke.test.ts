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
  workflowRunSlots,
  workflowRuns,
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

import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native workflow scheduler smoke tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("native workflow scheduler active smoke", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-native-scheduler-active-");
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

  it("creates exactly one native scheduled run for the same due slot across repeated active ticks", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Native Active Scheduler Company",
      issuePrefix: `NAS${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      timezone: "Asia/Seoul",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduler Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Native active scheduled workflow",
      status: "active",
      schedule: "0 10 * * *",
      timezone: "Asia/Seoul",
      stepsJson: [
        {
          id: "scheduled-step",
          name: "Scheduled step",
          agentId,
          dependencies: [],
        },
      ],
    });

    const scheduler = createNativeWorkflowScheduler({
      db,
      mode: "active",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const now = new Date("2026-06-11T01:05:00.000Z");

    await scheduler.tick(now);
    await scheduler.tick(now);

    const storedSlots = await db
      .select()
      .from(workflowRunSlots)
      .where(eq(workflowRunSlots.workflowDefinitionId, workflowId));
    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));

    expect(storedSlots).toHaveLength(1);
    expect(storedSlots[0]).toEqual(expect.objectContaining({
      companyId,
      triggerSource: "schedule",
      runDate: "2026-06-11",
      timezone: "Asia/Seoul",
    }));
    expect(storedSlots[0]!.scheduledAt.toISOString()).toBe("2026-06-11T01:00:00.000Z");
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toEqual(expect.objectContaining({
      companyId,
      workflowId,
      triggerSource: "schedule",
      runDate: "2026-06-11",
      scheduledSlotId: storedSlots[0]!.id,
    }));
  });
});
