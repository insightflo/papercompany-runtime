import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { markRetryDispatching } from "../services/workflow/dag-engine.js";
import { buildWorkflowRetryMetadata } from "../services/workflow/retry-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry dispatch CAS tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry dispatch CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-dispatch-cas-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryDispatchCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("loses CAS when request id changes after the observed select", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const observedRequestId = `req-${randomUUID()}`;
    const changedRequestId = `req-${randomUUID()}`;
    const retryMetadata = buildWorkflowRetryMetadata({
      retryNumber: 1,
      maxRetries: 2,
      delaySeconds: 0,
      now: new Date("2026-07-22T10:00:00.000Z"),
      sourceRequestId: "source-req",
      sourceCompletedAt: "2026-07-22T09:59:00.000Z",
      lastErrorSummary: "boom",
    });
    const metadata = {
      workflowRetry: retryMetadata,
      recoveryHint: "preserve-me",
    };

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retry dispatch CAS",
      stepsJson: [{ id: "tool-step", type: "tool", toolNames: ["t"], onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "tool-step",
      status: "running",
      retryCount: 1,
      lastDispatchRequestId: observedRequestId,
      metadata,
    });

    let settledWhileRowLocked = false;
    let updatePromise!: Promise<boolean>;
    await db.transaction(async (tx) => {
      await tx.update(workflowStepRuns)
        .set({ lastDispatchRequestId: changedRequestId })
        .where(eq(workflowStepRuns.id, stepRunId));
      updatePromise = markRetryDispatching(db, {
        stepRunId,
        workflowRunId,
        expectedRetryNumber: 1,
        observedRetryCount: 1,
        requiredStatus: "running",
        requiredLastDispatchRequestId: observedRequestId,
      });
      void updatePromise.then(() => {
        settledWhileRowLocked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settledWhileRowLocked).toBe(false);
    });
    const updated = await updatePromise;

    expect(updated).toBe(false);

    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(after.lastDispatchRequestId).toBe(changedRequestId);
    expect(after.metadata).toEqual(metadata);
  });
});
