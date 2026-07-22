import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { readWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry exhaustion marker tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry exhaustion markers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-exhaustion-marker-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears a stale exhaustion marker when scheduling a new retry", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const requestId = `req-${randomUUID()}`;
    const completedAt = new Date("2026-07-22T14:00:00.000Z");
    const observedMetadataSnapshot = {
      toolResult: { success: false, error: "boom" },
      workflowRetryExhaustion: { attempts: 4, maxRetries: 3 },
      workflowRetryAttempts: [{ retryNumber: 0, failedAt: completedAt.toISOString(), errorSummary: "boom" }],
    };

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry WF schedule clear",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 3 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "failed", triggeredBy: "test" });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "failed",
      retryCount: 0,
      completedAt,
      lastDispatchRequestId: requestId,
      lastDispatchErrorSummary: "boom",
      metadata: observedMetadataSnapshot,
    }).returning();

    const result = await scheduleWorkflowStepRetry(db, {
      companyId,
      workflowRunId,
      stepRunId: stepRun.id,
      retryNumber: 1,
      maxRetries: 3,
      delaySeconds: 0,
      observedStatus: "failed",
      observedRetryCount: 0,
      observedCompletedAt: completedAt,
      observedLastDispatchRequestId: requestId,
      observedMetadataSnapshot,
      errorSummary: "boom",
    });

    expect(result.result).toBe("scheduled");

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(metadata.workflowRetryExhaustion).toBeUndefined();
    expect(readWorkflowRetryMetadata(metadata.workflowRetry)).toEqual(
      expect.objectContaining({ retryNumber: 1, maxRetries: 3 }),
    );
  });

  it("writes exact attempts from retryCount plus one even when attempt history is capped", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const completedAt = new Date("2026-07-22T15:00:00.000Z");
    const workflowRetryAttempts = Array.from({ length: 20 }, (_, index) => ({
      retryNumber: index + 5,
      failedAt: new Date(completedAt.getTime() - (20 - index) * 1000).toISOString(),
      errorSummary: `failure-${index + 5}`,
    }));

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry WF exhausted",
      stepsJson: [{ id: stepId, type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 25 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "failed",
      retryCount: 25,
      startedAt: new Date("2026-07-22T14:59:00.000Z"),
      completedAt,
      lastDispatchRequestId: "retry-25",
      lastDispatchErrorSummary: "boom",
      lastDispatchAttemptAt: new Date("2026-07-22T15:00:00.000Z"),
      metadata: {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 25,
          maxRetries: 25,
          nextEligibleAt: completedAt.toISOString(),
          sourceRequestId: "retry-25",
          sourceCompletedAt: completedAt.toISOString(),
          lastErrorSummary: "boom",
        },
        workflowRetryAttempts,
      },
    }).returning();

    await syncWorkflowRunState(db, workflowRunId);

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toEqual({ attempts: 26, maxRetries: 25 });
    expect((metadata.workflowRetryAttempts as unknown[]).length).toBe(20);
    expect(
      await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id)),
    ).toEqual(expect.not.arrayContaining([expect.objectContaining({ eventType: "workflow_step_retry_scheduled" })]));
  });

  it("clears stale exhaustion markers for QA exclusions instead of reporting them exhausted", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `gate-${randomUUID().slice(0, 6)}`;
    const completedAt = new Date("2026-07-22T16:00:00.000Z");

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry WF qa exclusion",
      stepsJson: [{ id: stepId, name: "Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId,
      stepId,
      status: "failed",
      retryCount: 1,
      startedAt: new Date("2026-07-22T15:59:00.000Z"),
      completedAt,
      lastDispatchRequestId: "retry-1",
      lastDispatchErrorSummary: "structural_gate_request_changes",
      lastDispatchAttemptAt: new Date("2026-07-22T16:00:00.000Z"),
      metadata: {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: completedAt.toISOString(),
          sourceRequestId: "retry-1",
          sourceCompletedAt: completedAt.toISOString(),
          lastErrorSummary: "request changes",
        },
        workflowRetryExhaustion: { attempts: 99, maxRetries: 98 },
      },
    }).returning();

    await syncWorkflowRunState(db, workflowRunId);

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    const metadata = after.metadata as Record<string, unknown>;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(1);
    expect(metadata.workflowRetry).toBeUndefined();
    expect(metadata.workflowRetryExhaustion).toBeUndefined();
  });
});
