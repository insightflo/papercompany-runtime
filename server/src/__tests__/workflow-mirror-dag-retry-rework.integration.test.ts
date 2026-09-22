import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { assertAgentAssignments } from "./helpers/workflow-control-node-boundary.js";
import { getStepRun, getStepRuns, installMechanicalQaExecutor, mirrorFixture, processOneMechanicalQa, seedMirrorWorkflow, updateDecision } from "./helpers/workflow-mirror-dag-fixture.js";
import { completeWorkflowStepIssue } from "./helpers/workflow-mirror-dag-lifecycle.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function controlResult(metadata: unknown): { outcome?: string; evaluatedAt?: string } {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return (record.controlNodeResult ?? {}) as { outcome?: string; evaluatedAt?: string };
}

describeEmbeddedPostgres("mirror DAG retry and decision rework", () => {
  it("official retry re-dispatches a failed tool step on a new generation and admits publish only after success", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    await completeWorkflowStepIssue(seed, "validator", { requireVerdictPass: true });
    expect(requests).toHaveLength(0);
    const firstAttempt = await getStepRun(seed.runId, "mechanical-qa");
    expect(firstAttempt).toMatchObject({ status: "running", retryCount: 0, issueId: null });
    const generationBefore = firstAttempt.executionGeneration;
    expect(firstAttempt.lastDispatchRequestId).toBeTruthy();

    const failureResult = await processOneMechanicalQa(seed, requests, {
      success: false,
      error: "simulated qa failure",
    });
    expect(requests).toHaveLength(1);
    expect(failureResult.status).toBe("running");

    const retryEvents = await mirrorFixture.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowStepRunId, firstAttempt.id),
      eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"),
    ));
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.payload).toMatchObject({ retryNumber: 1, maxRetries: 1, delaySeconds: 0 });

    const retriedRow = await getStepRun(seed.runId, "mechanical-qa");
    expect(retriedRow).toMatchObject({ status: "running", retryCount: 1 });
    expect(retriedRow.executionGeneration).toBe(generationBefore + 1);
    expect(retriedRow.dispatchReadyAt).toBeNull();
    expect(retriedRow.lastDispatchRequestId).toBeTruthy();
    const retryMetadata = (retriedRow.metadata ?? {}) as Record<string, unknown>;
    expect(retryMetadata.workflowRetry).toMatchObject({
      retryNumber: 1,
      sourceRequestId: requests[0]?.requestId,
    });

    // A stale callback for the failed generation must be rejected without any write.
    const staleCallback = await completeWorkflowToolStepFromResult(mirrorFixture.db, {
      companyId: seed.companyId,
      stepRunId: firstAttempt.id,
      requestId: requests[0]?.requestId,
      success: true,
      data: { ok: true },
    });
    expect(staleCallback).toBeNull();

    const completion = await processOneMechanicalQa(seed, requests);
    expect(requests).toHaveLength(2);
    expect(completion.status).toBe("running");
    const completedRow = await getStepRun(seed.runId, "mechanical-qa");
    expect(completedRow).toMatchObject({ status: "completed", retryCount: 1 });
    expect(completedRow.dispatchReadyAt).not.toBeNull();
    const completedMetadata = (completedRow.metadata ?? {}) as Record<string, unknown>;
    expect(completedMetadata.workflowRetry).toBeUndefined();
    expect(completedMetadata.workflowRetryAttempts).toEqual([
      expect.objectContaining({
        retryNumber: 0,
        errorSummary: expect.stringContaining("simulated qa failure"),
      }),
    ]);
    expect(completedMetadata.toolResult).toMatchObject({
      success: true,
      requestId: requests[1]?.requestId,
    });

    const publishResult = await completeWorkflowStepIssue(seed, "publish");
    expect(publishResult?.status).toBe("completed");
    const finalRuns = await getStepRuns(seed.runId);
    expect(finalRuns.length).toBeGreaterThan(0);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("publish")?.status).toBe("completed");
    await assertAgentAssignments(mirrorFixture.db, {
      companyId: seed.companyId,
      agentId: seed.agentId,
      runId: seed.runId,
      steps: [
        { stepId: "producer", issueId: finalById.get("producer")!.issueId },
        { stepId: "validator", issueId: finalById.get("validator")!.issueId, mutations: ["create", "workflow_resume"] },
        { stepId: "publish", issueId: finalById.get("publish")!.issueId },
      ],
    });
  });

  it("rework false to true: stale decisions re-evaluate, the assigned validator is retained, and QA runs once", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    const initialDecision = await getStepRun(seed.runId, "decision");
    const initialResult = controlResult(initialDecision.metadata);
    expect(initialResult.outcome).toBe("condition_false");
    const initialValidator = await getStepRun(seed.runId, "validator");
    expect(initialValidator).toMatchObject({ status: "pending" });
    expect(initialValidator.issueId).toBeTruthy();
    expect(requests).toHaveLength(0);

    await updateDecision(seed, "selected");
    await workflowService.resumeRun(mirrorFixture.db, { runId: seed.runId, companyId: seed.companyId });

    const flippedDecision = await getStepRun(seed.runId, "decision");
    const flippedResult = controlResult(flippedDecision.metadata);
    expect(flippedResult.outcome).toBe("condition_true");
    expect(flippedResult.evaluatedAt).not.toBe(initialResult.evaluatedAt);
    expect(flippedDecision.dispatchReadyAt).not.toBeNull();
    // The engine intentionally retains the already-assigned validator.
    const retainedValidator = await getStepRun(seed.runId, "validator");
    expect(retainedValidator).toMatchObject({ status: "pending", issueId: initialValidator.issueId });
    expect((await getStepRun(seed.runId, "mirror")).status).toBe("pending");
    expect((await getStepRun(seed.runId, "mechanical-qa")).status).toBe("pending");
    expect(requests).toHaveLength(0);

    await completeWorkflowStepIssue(seed, "validator", { requireVerdictPass: true });
    const mirrorRow = await getStepRun(seed.runId, "mirror");
    expect(controlResult(mirrorRow.metadata)).toMatchObject({ outcome: "condition_true" });
    expect(mirrorRow.dispatchReadyAt).not.toBeNull();
    const afterQa = await processOneMechanicalQa(seed, requests);
    expect(requests).toHaveLength(1);
    expect(afterQa.status).toBe("running");
    const publishResult = await completeWorkflowStepIssue(seed, "publish");
    expect(publishResult?.status).toBe("completed");
    const finalValidator = await getStepRun(seed.runId, "validator");
    expect(finalValidator.issueId).toBe(initialValidator.issueId);
  });

  it("rework true to false: official artifact invalidation and engine sync revive the false branch", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const queuedQa = await getStepRun(seed.runId, "mechanical-qa");
    expect(queuedQa).toMatchObject({ status: "running", issueId: null });
    expect(requests).toHaveLength(0);
    const initialDecision = await getStepRun(seed.runId, "decision");
    const initialResult = controlResult(initialDecision.metadata);
    expect(initialResult.outcome).toBe("condition_true");

    await updateDecision(seed, "empty");
    await workflowService.resumeRun(mirrorFixture.db, { runId: seed.runId, companyId: seed.companyId });

    const flippedDecision = await getStepRun(seed.runId, "decision");
    const flippedResult = controlResult(flippedDecision.metadata);
    expect(flippedResult.outcome).toBe("condition_false");
    expect(flippedResult.evaluatedAt).not.toBe(initialResult.evaluatedAt);
    expect(flippedDecision.dispatchReadyAt).not.toBeNull();
    // The stale IF is re-evaluated in this resume. Existing engine ordering performs
    // skipped-branch revival on the next official sync, after the new false outcome
    // is durable; this test intentionally does not force the validator status.
    const revivedValidator = await getStepRun(seed.runId, "validator");
    expect(revivedValidator).toMatchObject({ status: "skipped", issueId: null });
    expect((await getStepRun(seed.runId, "mirror")).status).toBe("skipped");

    // This second call is the existing official engine retry/sync contract. It covers
    // recovery after official invalidation, not an unverified same-resume guarantee.
    await workflowService.resumeRun(mirrorFixture.db, { runId: seed.runId, companyId: seed.companyId });
    const recoveredValidator = await getStepRun(seed.runId, "validator");
    expect(recoveredValidator).toMatchObject({ status: "pending" });
    expect(recoveredValidator.issueId).toBeTruthy();
    expect((await getStepRun(seed.runId, "mirror")).status).toBe("skipped");

    const held = await processQueuedWorkflowToolStepRuns(mirrorFixture.db);
    expect(held).toMatchObject({ claimedCount: 0, executedCount: 0, skippedCount: 1 });
    expect(requests).toHaveLength(0);

    await completeWorkflowStepIssue(seed, "validator", { requireVerdictPass: true });
    const mirrorRow = await getStepRun(seed.runId, "mirror");
    expect(controlResult(mirrorRow.metadata)).toMatchObject({ outcome: "condition_false" });
    const afterQa = await processOneMechanicalQa(seed, requests);
    expect(requests).toHaveLength(1);
    expect(afterQa.status).toBe("running");
    const publishResult = await completeWorkflowStepIssue(seed, "publish");
    expect(publishResult?.status).toBe("completed");
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("mechanical-qa")?.status).toBe("completed");
    expect(finalById.get("publish")?.status).toBe("completed");
  });
});
