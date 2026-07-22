import { describe, expect, it } from "vitest";
import {
  buildTerminalMissionHumanOperatorComment,
  buildTerminalMissionSnapshotKey,
  classifyTerminalMissionContinuation,
  summarizeWorkflowRetryExhaustion,
} from "../services/missions/terminal-mission-human-operator-alert.js";
import { missionWorkflowContinuationRemains, type WorkflowContinuationStepRow } from "../services/missions/terminal-mission-workflow-continuation.js";

type StepDef = { id: string; dependencies?: string[]; conditionalDependencies?: Array<{ stepId: string; when: string; isBackEdge?: boolean }>; type?: string };

function row(runId: string, steps: StepDef[], stepId: string, status: string, metadata?: unknown): WorkflowContinuationStepRow {
  return { run: { id: runId }, stepRun: { stepId, status, metadata }, definition: { stepsJson: steps } };
}

describe("retry exhaustion summary in Human Operator report", () => {
  it("includes bounded attempts/maxRetries in evidence when retries were exhausted", () => {
    const body = buildTerminalMissionHumanOperatorComment({
      issueId: "i1",
      issueIdentifier: "RES-1",
      missionTitle: "Retry Mission",
      sourceIssueIdentifier: "RES-42",
      failedRuns: [{ id: "r1", status: "failed", errorCode: null }],
      retryAttempts: 3,
      retryMaxRetries: 2,
    });
    expect(body).toContain("retry-exhausted=3/2");
    expect(body).not.toContain("errorSummary");
    expect(body).not.toContain("workflowRetry");
  });

  it("omits retry-exhausted when no retry history (non-retry failure)", () => {
    const body = buildTerminalMissionHumanOperatorComment({
      issueId: "i1",
      issueIdentifier: "RES-1",
      missionTitle: "Plain Mission",
      sourceIssueIdentifier: null,
      failedRuns: [{ id: "r1", status: "failed", errorCode: "boom" }],
    });
    expect(body).not.toContain("retry-exhausted");
  });

  it("summarizeWorkflowRetryExhaustion computes attempts and maxRetries from step metadata", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      {
        status: "failed",
        metadata: {
          workflowRetryAttempts: Array.from({ length: 20 }, (_, retryNumber) => ({
            retryNumber,
            failedAt: "2026-07-22T10:00:00Z",
            errorSummary: "bounded history",
          })),
          workflowRetryExhaustion: { attempts: 26, maxRetries: 25 },
        },
      },
    ]);
    expect(summary).toEqual({ retryAttempts: 26, retryMaxRetries: 25 });
  });

  it("summarizeWorkflowRetryExhaustion returns null for non-retry failures", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      { status: "failed", metadata: {} },
    ]);
    expect(summary).toBeNull();
  });

  it("summarizeWorkflowRetryExhaustion omits malformed markers", () => {
    const summary = summarizeWorkflowRetryExhaustion([
      {
        status: "failed",
        metadata: { workflowRetryExhaustion: { attempts: 26, maxRetries: "25" } },
      },
    ]);
    expect(summary).toBeNull();
  });

  it("idempotency: same failed-run fingerprint reuses snapshot key regardless of retry summary", () => {
    const baseInput = {
      companyId: "c1",
      missionId: "m1",
      workflowRunId: "run-1",
      failedRuns: [{ id: "r1", status: "failed", errorCode: null }],
    };
    const key1 = buildTerminalMissionSnapshotKey(baseInput);
    const key2 = buildTerminalMissionSnapshotKey(baseInput);
    expect(key1).toBe(key2);
  });
});

describe("retry interlock with Human Operator reporting", () => {
  it("active retry (pending step with workflowRetry) suppresses terminal escalation", () => {
    const steps: StepDef[] = [
      { id: "worker", dependencies: [] },
    ];
    // Step is pending with active retry metadata → continuation remains → suppresses report
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "worker", "pending", {
        workflowRetry: {
          state: "waiting",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: new Date(Date.now() + 30000).toISOString(),
        },
      }),
    ]);
    expect(verdict.remains).toBe(true);
  });

  it("dispatching retry also suppresses terminal escalation", () => {
    const steps: StepDef[] = [
      { id: "worker", dependencies: [] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "worker", "pending", {
        workflowRetry: {
          state: "dispatching",
          retryNumber: 1,
          maxRetries: 2,
          nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    ]);
    expect(verdict.remains).toBe(true);
  });

  it("exhausted retry (failed step, no continuation) allows terminal escalation", () => {
    const steps: StepDef[] = [
      { id: "worker", dependencies: [] },
    ];
    // Step is failed after exhaustion → no continuation → allows report
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "worker", "failed", {
        workflowRetryAttempts: [
          { retryNumber: 0, failedAt: "2026-07-22T10:00:00.000Z", errorSummary: "fail 1" },
          { retryNumber: 1, failedAt: "2026-07-22T10:01:00.000Z", errorSummary: "fail 2" },
        ],
      }),
    ]);
    expect(verdict.remains).toBe(false);
  });

  it("failed step with maxRetries 0 and no continuation allows terminal escalation", () => {
    const steps: StepDef[] = [
      { id: "worker", dependencies: [] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "worker", "failed"),
    ]);
    expect(verdict.remains).toBe(false);
  });

  it("classifyTerminalMissionContinuation suppresses when workflow retry is pending", () => {
    const steps: StepDef[] = [{ id: "worker", dependencies: [] }];
    const verdict = classifyTerminalMissionContinuation({
      missionStatus: "active",
      missionHasActiveHeartbeat: false,
      missionIssueIds: [],
      liveWakeupIssueIds: new Set(),
      openOwnerActionRecoveryExists: false,
      workflowStepRows: [
        row("run-1", steps, "worker", "pending", {
          workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt: "2026-07-22T12:00:00.000Z" },
        }),
      ],
      validationVerdictsByIssueId: undefined,
    });
    expect(verdict.terminal).toBe(false);
  });

  it("classifyTerminalMissionContinuation allows escalation after retry exhaustion", () => {
    const steps: StepDef[] = [{ id: "worker", dependencies: [] }];
    const verdict = classifyTerminalMissionContinuation({
      missionStatus: "active",
      missionHasActiveHeartbeat: false,
      missionIssueIds: [],
      liveWakeupIssueIds: new Set(),
      openOwnerActionRecoveryExists: false,
      workflowStepRows: [
        row("run-1", steps, "worker", "failed"),
      ],
      validationVerdictsByIssueId: undefined,
    });
    expect(verdict.terminal).toBe(true);
  });
});
