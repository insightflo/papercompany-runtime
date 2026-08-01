import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileWorkflow } from "../services/workflow/reconciler.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry reconciler accounting tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry reconciler accounting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-reconciler-accounting-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("counts released retries only when a due waiting retry actually transitions", async () => {
    const workerAgentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;
    const stepRunId = randomUUID();
    const dueAt = new Date(Date.now() - 60_000).toISOString();

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry WF",
      stepsJson: [{ id: stepId, name: "Worker", agentId: workerAgentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
      startedAt: new Date(Date.now() - 120_000),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: null,
      status: "blocked",
      title: "Retry source",
      body: "",
      source: "workflow",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId,
      issueId,
      status: "pending",
      retryCount: 1,
      metadata: {
        workflowRetry: {
          state: "waiting",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: dueAt,
          sourceRequestId: "retry-1",
          sourceCompletedAt: dueAt,
          lastErrorSummary: "boom",
        },
      },
    });

    const blocked = await reconcileWorkflow(db, { timeoutMinutes: 60 });
    expect(blocked.retryReconciliationsReleased).toBe(0);

    const [stillWaiting] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stillWaiting.status).toBe("pending");
    expect(readWorkflowRetryMetadata((stillWaiting.metadata as Record<string, unknown>).workflowRetry)).toEqual(
      expect.objectContaining({ state: "waiting", retryNumber: 1 }),
    );
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, issueId))).toHaveLength(0);

    await db.insert(agents).values({
      id: workerAgentId,
      companyId,
      name: `Worker-${stepId}`,
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const unblocked = await reconcileWorkflow(db, { timeoutMinutes: 60 });
    expect(unblocked.retryReconciliationsReleased).toBe(1);

    const [dispatched] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(dispatched.status).toBe("pending");
    expect(readWorkflowRetryMetadata((dispatched.metadata as Record<string, unknown>).workflowRetry)).toEqual(
      expect.objectContaining({ state: "dispatching", retryNumber: 1 }),
    );

    const again = await reconcileWorkflow(db, { timeoutMinutes: 60 });
    expect(again.retryReconciliationsReleased).toBe(0);
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, issueId)),
    ).toHaveLength(1);
  });
});
