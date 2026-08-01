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

import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow scheduler claim tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow native scheduler slot claiming", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-scheduler-claim-");
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

  it("claims a scheduled slot atomically so duplicate scheduler ticks create only one run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const scheduledAt = new Date("2026-06-11T00:00:00.000Z");

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Scheduler Claim Company",
      issuePrefix: `SC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "Daily scheduled workflow",
      status: "active",
      schedule: "0 9 * * *",
      timezone: "Asia/Seoul",
      lastScheduleError: "stale scheduler error",
      lastScheduleErrorAt: new Date("2026-06-10T00:00:00.000Z"),
      stepsJson: [
        {
          id: "scheduled-step",
          name: "Scheduled step",
          agentId,
          dependencies: [],
        },
      ],
    });

    const claim = (workflowService as unknown as {
      claimScheduledRun: (
        db: typeof db,
        input: {
          workflowId: string;
          companyId: string;
          scheduledAt: Date;
          runDate: string;
          timezone: string;
        },
      ) => Promise<{ claimed: boolean }>;
    }).claimScheduledRun;

    const results = await Promise.all([
      claim(db, {
        workflowId,
        companyId,
        scheduledAt,
        runDate: "2026-06-11",
        timezone: "Asia/Seoul",
      }),
      claim(db, {
        workflowId,
        companyId,
        scheduledAt,
        runDate: "2026-06-11",
        timezone: "Asia/Seoul",
      }),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toHaveLength(1);

    const storedSlots = await db
      .select()
      .from(workflowRunSlots)
      .where(eq(workflowRunSlots.workflowDefinitionId, workflowId));
    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));
    const [storedDefinition] = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, workflowId))
      .limit(1);

    expect(storedSlots).toHaveLength(1);
    expect(storedSlots[0]).toEqual(expect.objectContaining({
      companyId,
      triggerSource: "schedule",
      runDate: "2026-06-11",
      timezone: "Asia/Seoul",
    }));
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toEqual(expect.objectContaining({
      companyId,
      workflowId,
      triggerSource: "schedule",
      runDate: "2026-06-11",
      scheduledSlotId: storedSlots[0]!.id,
    }));
    expect(storedDefinition).toEqual(expect.objectContaining({
      lastScheduledRunAt: scheduledAt,
      lastScheduleError: null,
      lastScheduleErrorAt: null,
    }));
  });

  it("marks a claimed scheduled slot as failed when native trigger creation fails", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const scheduledAt = new Date("2026-06-11T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Scheduler Trigger Failure Company",
      issuePrefix: `STF${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      timezone: "Asia/Seoul",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Scheduled workflow without owner",
      status: "active",
      schedule: "0 10 * * *",
      timezone: "Asia/Seoul",
      stepsJson: [
        {
          id: "ownerless-step",
          name: "Ownerless step",
          dependencies: [],
        },
      ],
    });

    const claim = (workflowService as unknown as {
      claimScheduledRun: (
        db: typeof db,
        input: {
          workflowId: string;
          companyId: string;
          scheduledAt: Date;
          runDate: string;
          timezone: string;
        },
      ) => Promise<{ claimed: boolean }>;
    }).claimScheduledRun;

    await expect(claim(db, {
      workflowId,
      companyId,
      scheduledAt,
      runDate: "2026-06-11",
      timezone: "Asia/Seoul",
    })).rejects.toThrow("Cannot create workflow mission: no agent exists for company");

    const storedSlots = await db
      .select()
      .from(workflowRunSlots)
      .where(eq(workflowRunSlots.workflowDefinitionId, workflowId));
    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId));
    const [storedDefinition] = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, workflowId))
      .limit(1);

    expect(storedSlots).toHaveLength(1);
    expect(storedSlots[0]).toEqual(expect.objectContaining({
      companyId,
      status: "failed",
    }));
    expect(storedSlots[0]!.metadata).toEqual(expect.objectContaining({
      scheduledAt: scheduledAt.toISOString(),
      triggerError: "Cannot create workflow mission: no agent exists for company",
    }));
    expect(storedRuns).toHaveLength(0);
    expect(storedDefinition).toEqual(expect.objectContaining({
      lastScheduledRunAt: scheduledAt,
      lastScheduleError: "Cannot create workflow mission: no agent exists for company",
    }));
    expect(storedDefinition?.lastScheduleErrorAt).toBeInstanceOf(Date);
  });
});
