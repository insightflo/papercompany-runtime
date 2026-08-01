import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileDeadlockedWorkflowRuns } from "../services/workflow/reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow rework reconciler liveness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("recovers a failed rework iteration when no heartbeat or wakeup is live", async () => {
    const ids = seedIds();
    await seedFailedReworkRun(db, ids);

    const result = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(result).toEqual([expect.objectContaining({ runId: ids.runId, action: "recovered" })]);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, ids.runId));
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, ids.runId));
    expect(run?.status).toBe("failed");
    expect(steps.find((step) => step.stepId === "deliver")?.status).toBe("skipped");
  });

  it("skips cleanup while a rework wakeup is still live", async () => {
    const ids = seedIds();
    await seedFailedReworkRun(db, ids);
    await db.insert(agentWakeupRequests).values({
      companyId: ids.companyId,
      agentId: ids.agentId,
      issueId: ids.reworkIssueId,
      workflowRunId: ids.runId,
      source: "test",
      reason: "workflow_resume",
      status: "queued",
    });

    const result = await reconcileDeadlockedWorkflowRuns(db, 0);

    expect(result).toEqual([]);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, ids.runId));
    expect(run?.status).toBe("running");
  });
});

function seedIds() {
  return {
    companyId: randomUUID(),
    workflowId: randomUUID(),
    runId: randomUUID(),
    agentId: randomUUID(),
    reworkIssueId: randomUUID(),
    deliveryIssueId: randomUUID(),
  };
}

async function seedFailedReworkRun(db: ReturnType<typeof createDb>, ids: ReturnType<typeof seedIds>) {
  await db.insert(companies).values({
    id: ids.companyId,
    name: "Rework Reconciler Company",
    issuePrefix: `RR${ids.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(workflowDefinitions).values({
    id: ids.workflowId,
    companyId: ids.companyId,
    name: "rework-deadlock",
    stepsJson: [
      { id: "analyze", name: "Analyze", type: "agent", agentId: ids.agentId, dependencies: [] },
      { id: "deliver", name: "Deliver", type: "agent", agentId: ids.agentId, dependencies: ["analyze"] },
    ],
  });
  await db.insert(agents).values({
    id: ids.agentId,
    companyId: ids.companyId,
    name: "Worker",
    role: "worker",
  });
  await db.insert(workflowRuns).values({
    id: ids.runId,
    workflowId: ids.workflowId,
    companyId: ids.companyId,
    status: "running",
    triggeredBy: "schedule",
    startedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  await db.insert(issues).values([
    { id: ids.reworkIssueId, companyId: ids.companyId, title: "Analyze", status: "blocked" },
    { id: ids.deliveryIssueId, companyId: ids.companyId, title: "Deliver", status: "todo" },
  ]);
  await db.insert(workflowStepRuns).values([
    {
      workflowRunId: ids.runId,
      stepId: "analyze",
      issueId: ids.reworkIssueId,
      status: "failed",
      iterationIndex: 1,
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: new Date("2020-01-01T00:05:00.000Z"),
    },
    {
      workflowRunId: ids.runId,
      stepId: "deliver",
      issueId: ids.deliveryIssueId,
      status: "pending",
    },
  ]);
}
