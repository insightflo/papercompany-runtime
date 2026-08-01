import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry scheduler CAS tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry scheduler metadata CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-scheduler-cas-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("returns already_changed when metadata changed after the observed snapshot", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const requestId = `req-${randomUUID()}`;
    const completedAt = new Date("2026-07-22T08:00:00.000Z");
    const observedMetadata = {
      toolResult: { success: false, error: "boom" },
      recoveryHint: "before",
    };

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry WF",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
    });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "failed",
      retryCount: 0,
      completedAt,
      lastDispatchRequestId: requestId,
      lastDispatchErrorSummary: "tool failed",
      metadata: observedMetadata,
    }).returning();

    const mutatedMetadata = {
      ...observedMetadata,
      recoveryHint: "after",
      unrelatedMutation: true,
    };
    await db.update(workflowStepRuns)
      .set({ metadata: mutatedMetadata })
      .where(eq(workflowStepRuns.id, stepRun.id));

    const result = await scheduleWorkflowStepRetry(db, {
      companyId,
      workflowRunId,
      stepRunId: stepRun.id,
      retryNumber: 1,
      maxRetries: 2,
      delaySeconds: 0,
      observedStatus: "failed",
      observedRetryCount: 0,
      observedCompletedAt: completedAt,
      observedLastDispatchRequestId: requestId,
      observedMetadataSnapshot: observedMetadata,
      errorSummary: "tool failed",
    });

    expect(result).toEqual({ result: "already_changed", stepRunId: stepRun.id });

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    expect(after.metadata).toEqual(mutatedMetadata);

    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events).toHaveLength(0);
  });
});
