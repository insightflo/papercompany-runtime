import { describe, expect, it } from "vitest";
import { classifyDueWorkflowRetryRelease } from "../services/workflow/retry-reconciler.js";

const candidate = {
  stepRunId: "step-run-1",
  workflowRunId: "workflow-run-1",
  retryNumber: 2,
  sourceRequestId: "request-1",
} as const;

function waitingRetry(state: "waiting" | "dispatching") {
  return {
    workflowRetry: {
      state,
      retryNumber: candidate.retryNumber,
      maxRetries: 2,
      nextEligibleAt: "2026-07-22T10:00:00.000Z",
      sourceRequestId: candidate.sourceRequestId,
      sourceCompletedAt: "2026-07-22T09:59:00.000Z",
      lastErrorSummary: "boom",
    },
  };
}

function current(overrides: Partial<{
  stepRunId: string;
  workflowRunId: string;
  status: string;
  retryCount: number;
  metadata: unknown;
  lastDispatchRequestId: string | null;
  lastDispatchAcceptedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}>) {
  return {
    stepRunId: candidate.stepRunId,
    workflowRunId: candidate.workflowRunId,
    status: "pending",
    retryCount: candidate.retryNumber,
    metadata: waitingRetry("waiting"),
    lastDispatchRequestId: null,
    lastDispatchAcceptedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("classifyDueWorkflowRetryRelease", () => {
  it("returns exact outcomes for waiting, dispatching, active, completed, and terminalized states", () => {
    const outcomes = [
      classifyDueWorkflowRetryRelease(candidate, current({})),
      classifyDueWorkflowRetryRelease(candidate, current({ metadata: waitingRetry("dispatching") })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "running", metadata: {}, lastDispatchRequestId: "request-2", lastDispatchAcceptedAt: new Date("2026-07-22T10:00:01.000Z") })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "completed", metadata: {}, lastDispatchRequestId: "request-2", completedAt: new Date("2026-07-22T10:00:02.000Z") })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "failed", metadata: { workflowRetryExhaustion: { attempts: 3, maxRetries: 2 } }, lastDispatchRequestId: "request-2", completedAt: new Date("2026-07-22T10:00:02.000Z") })),
      classifyDueWorkflowRetryRelease(candidate, undefined),
    ];

    expect(outcomes).toEqual(["skipped", "recovered", "recovered", "recovered", "failed", "failed"]);
  });

  it("fails when retry metadata disappears, request evidence is stale, or no new dispatch exists", () => {
    const outcomes = [
      classifyDueWorkflowRetryRelease(candidate, current({ metadata: {} })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "running", metadata: {}, lastDispatchRequestId: candidate.sourceRequestId, lastDispatchAcceptedAt: new Date("2026-07-22T10:00:01.000Z") })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "running", metadata: {}, lastDispatchRequestId: "request-2" })),
      classifyDueWorkflowRetryRelease(candidate, current({ workflowRunId: "workflow-run-2" })),
      classifyDueWorkflowRetryRelease(candidate, current({ retryCount: 1 })),
      classifyDueWorkflowRetryRelease(candidate, current({ status: "cancelled", metadata: {}, lastDispatchRequestId: "request-2", completedAt: new Date("2026-07-22T10:00:02.000Z") })),
    ];

    expect(outcomes).toEqual(["failed", "failed", "failed", "failed", "failed", "failed"]);
  });
});
