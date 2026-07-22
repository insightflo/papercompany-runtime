import { describe, expect, it } from "vitest";
import { summarizeWorkflowRetryExhaustion } from "../services/missions/terminal-mission-human-operator-alert.js";

describe("summarizeWorkflowRetryExhaustion", () => {
  it("reads the authoritative exhaustion marker even when retry history is capped", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      {
        status: "failed",
        metadata: {
          workflowRetryAttempts: Array.from({ length: 20 }, (_, retryNumber) => ({
            retryNumber,
            failedAt: `2026-07-22T10:${String(retryNumber).padStart(2, "0")}:00.000Z`,
            errorSummary: `bounded-${retryNumber}`,
          })),
          workflowRetryExhaustion: { attempts: 26, maxRetries: 25 },
        },
      },
    ]);

    expect(summary).toEqual({ retryAttempts: 26, retryMaxRetries: 25 });
  });

  it("keeps the exact 3/2 exhaustion marker", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      { status: "failed", metadata: { workflowRetryExhaustion: { attempts: 3, maxRetries: 2 } } },
    ]);

    expect(summary).toEqual({ retryAttempts: 3, retryMaxRetries: 2 });
  });

  it("returns null for history-only failures without an exhaustion marker", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      {
        status: "failed",
        metadata: {
          workflowRetryAttempts: Array.from({ length: 20 }, (_, retryNumber) => ({
            retryNumber,
            failedAt: `2026-07-22T11:${String(retryNumber).padStart(2, "0")}:00.000Z`,
            errorSummary: `history-${retryNumber}`,
          })),
        },
      },
    ]);

    expect(summary).toBeNull();
  });

  it("returns null when retries were cleared for a failure-route handoff", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      {
        status: "failed",
        metadata: {
          workflowRetryAttempts: [
            { retryNumber: 0, failedAt: "2026-07-22T12:00:00.000Z", errorSummary: "first" },
            { retryNumber: 1, failedAt: "2026-07-22T12:05:00.000Z", errorSummary: "second" },
          ],
          failureRoute: { targetStepId: "recover" },
        },
      },
    ]);

    expect(summary).toBeNull();
  });

  it("returns null for malformed or inconsistent exhaustion markers", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      { status: "failed", metadata: { workflowRetryExhaustion: { attempts: 2, maxRetries: 2 } } },
      { status: "failed", metadata: { workflowRetryExhaustion: { attempts: 5, maxRetries: 1 } } },
      { status: "failed", metadata: { workflowRetryExhaustion: { attempts: 0, maxRetries: 0 } } },
      { status: "failed", metadata: { workflowRetryExhaustion: { attempts: 3.5, maxRetries: 2 } } },
    ]);

    expect(summary).toBeNull();
  });

  it("returns null for plain non-retry failures with no authoritative marker", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      { status: "failed", metadata: { lastDispatchErrorSummary: "plain failure" } },
    ]);

    expect(summary).toBeNull();
  });
});
