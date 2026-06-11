import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, workflowDefinitions } from "@paperclipai/db";
import {
  computeDueScheduledWorkflowCandidates,
  findRecentScheduledSlot,
  listDueScheduledWorkflowCandidates,
} from "../services/workflow/scheduler-candidates.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow scheduler candidate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("workflow native scheduler candidates", () => {
  it("finds the exact UTC scheduled slot from the workflow timezone", () => {
    const now = new Date("2026-06-11T01:05:30.000Z");

    const slot = findRecentScheduledSlot("0 10 * * *", now, "Asia/Seoul");

    expect(slot?.toISOString()).toBe("2026-06-11T01:00:00.000Z");
  });

  it("computes due candidates using workflow timezone before company timezone", () => {
    const now = new Date("2026-06-11T01:05:00.000Z");

    const candidates = computeDueScheduledWorkflowCandidates([
      {
        id: "wf-workflow-tz",
        companyId: "company-1",
        name: "Workflow timezone wins",
        status: "active",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        companyTimezone: "UTC",
        lastScheduledRunAt: null,
      },
      {
        id: "wf-company-tz",
        companyId: "company-1",
        name: "Company timezone fallback",
        status: "active",
        schedule: "0 1 * * *",
        timezone: null,
        companyTimezone: "UTC",
        lastScheduledRunAt: null,
      },
    ], { now });

    expect(candidates.map((candidate) => candidate.workflowId)).toEqual([
      "wf-workflow-tz",
      "wf-company-tz",
    ]);
    expect(candidates[0]).toEqual(expect.objectContaining({
      workflowId: "wf-workflow-tz",
      companyId: "company-1",
      timezone: "Asia/Seoul",
      runDate: "2026-06-11",
    }));
    expect(candidates[0]!.scheduledAt.toISOString()).toBe("2026-06-11T01:00:00.000Z");
    expect(candidates[1]).toEqual(expect.objectContaining({
      workflowId: "wf-company-tz",
      timezone: "UTC",
      runDate: "2026-06-11",
    }));
    expect(candidates[1]!.scheduledAt.toISOString()).toBe("2026-06-11T01:00:00.000Z");
  });

  it("skips inactive, unscheduled, and already-claimed scheduled slots", () => {
    const now = new Date("2026-06-11T01:05:00.000Z");

    const candidates = computeDueScheduledWorkflowCandidates([
      {
        id: "wf-already-claimed",
        companyId: "company-1",
        name: "Already claimed",
        status: "active",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        companyTimezone: null,
        lastScheduledRunAt: new Date("2026-06-11T01:00:00.000Z"),
      },
      {
        id: "wf-paused",
        companyId: "company-1",
        name: "Paused",
        status: "paused",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        companyTimezone: null,
        lastScheduledRunAt: null,
      },
      {
        id: "wf-manual",
        companyId: "company-1",
        name: "Manual only",
        status: "active",
        schedule: null,
        timezone: "Asia/Seoul",
        companyTimezone: null,
        lastScheduledRunAt: null,
      },
    ], { now });

    expect(candidates).toEqual([]);
  });
});

describeEmbeddedPostgres("workflow native scheduler candidate readback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-scheduler-candidates-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowDefinitions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads active due workflows from native tables with company timezone fallback", async () => {
    const companyId = randomUUID();
    const dueWorkflowId = randomUUID();
    const alreadyClaimedWorkflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Scheduler Candidate Company",
      issuePrefix: `SCD${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      timezone: "Asia/Seoul",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values([
      {
        id: dueWorkflowId,
        companyId,
        name: "Due company timezone workflow",
        status: "active",
        schedule: "0 10 * * *",
        timezone: null,
        stepsJson: [],
      },
      {
        id: alreadyClaimedWorkflowId,
        companyId,
        name: "Already claimed workflow",
        status: "active",
        schedule: "0 10 * * *",
        timezone: null,
        lastScheduledRunAt: new Date("2026-06-11T01:00:00.000Z"),
        stepsJson: [],
      },
    ]);

    const candidates = await listDueScheduledWorkflowCandidates(db, {
      now: new Date("2026-06-11T01:05:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({
      workflowId: dueWorkflowId,
      companyId,
      timezone: "Asia/Seoul",
      runDate: "2026-06-11",
    }));
    expect(candidates[0]!.scheduledAt.toISOString()).toBe("2026-06-11T01:00:00.000Z");
  });
});
