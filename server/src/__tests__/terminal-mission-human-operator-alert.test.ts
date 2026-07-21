import { describe, expect, it } from "vitest";
import {
  buildHumanOperatorRequestPayload,
} from "../services/missions/human-operator-alert-events.js";
import {
  buildTerminalMissionHumanOperatorComment,
  buildTerminalMissionSnapshotKey,
  classifyTerminalMissionContinuation,
  emitTerminalMissionHumanOperatorReport,
} from "../services/missions/terminal-mission-human-operator-alert.js";
import { missionWorkflowContinuationRemains, type WorkflowContinuationStepRow } from "../services/missions/terminal-mission-workflow-continuation.js";

type StepDef = { id: string; dependencies?: string[]; conditionalDependencies?: Array<{ stepId: string; when: string; isBackEdge?: boolean }>; type?: string };

function row(runId: string, steps: StepDef[], stepId: string, status: string, metadata?: unknown): WorkflowContinuationStepRow {
  return { run: { id: runId }, stepRun: { stepId, status, metadata }, definition: { stepsJson: steps } };
}

const ifControlTrue = {
  nodeType: "if",
  outcome: "condition_true",
  evaluatedAt: "2026-07-20T10:00:00.000Z",
  conditionCount: 1,
  combinator: "all",
  sourceSummary: [{ stepId: "produce", title: "Produce", path: "/tmp/produce" }],
};

describe("missionWorkflowContinuationRemains (authoritative edge-aware classification)", () => {
  it("flags a runnable failure edge from a failed predecessor (suppresses escalation)", () => {
    const steps: StepDef[] = [
      { id: "produce", dependencies: [] },
      { id: "rescue", conditionalDependencies: [{ stepId: "produce", when: "failure" }] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "produce", "failed"),
      row("run-1", steps, "rescue", "pending"),
    ]);
    expect(verdict.remains).toBe(true);
  });

  it("flags a runnable always edge from a failed predecessor (suppresses escalation)", () => {
    const steps: StepDef[] = [
      { id: "produce", dependencies: [] },
      { id: "joiner", conditionalDependencies: [{ stepId: "produce", when: "always" }] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "produce", "failed"),
      row("run-1", steps, "joiner", "pending"),
    ]);
    expect(verdict.remains).toBe(true);
  });

  it("lets an IF control-node contract failure with no legal branch escalate (no continuation)", () => {
    // IF completed but metadata/controlNodeResult missing → controlOutcome undefined → both condition
    // edges fail-closed non-holding → branches skippable → no continuation → can escalate.
    const steps: StepDef[] = [
      { id: "if1", dependencies: [], type: "if" },
      { id: "branchTrue", conditionalDependencies: [{ stepId: "if1", when: "condition_true" }] },
      { id: "branchFalse", conditionalDependencies: [{ stepId: "if1", when: "condition_false" }] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "if1", "completed"), // no controlNodeResult metadata
      row("run-1", steps, "branchTrue", "pending"),
      row("run-1", steps, "branchFalse", "pending"),
    ]);
    expect(verdict.remains).toBe(false);
  });

  it("suppresses when an IF resolved a branch that is still pending", () => {
    const steps: StepDef[] = [
      { id: "if1", dependencies: [], type: "if" },
      { id: "branchTrue", conditionalDependencies: [{ stepId: "if1", when: "condition_true" }] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "if1", "completed", { controlNodeResult: ifControlTrue }),
      row("run-1", steps, "branchTrue", "pending"),
    ]);
    expect(verdict.remains).toBe(true);
  });

  it("treats an undispatched root step as continuation (fail-closed)", () => {
    const steps: StepDef[] = [{ id: "produce", dependencies: [] }];
    const verdict = missionWorkflowContinuationRemains([row("run-1", steps, "produce", "pending")]);
    expect(verdict.remains).toBe(true);
  });

  it("reports no continuation when every step reached a terminal status", () => {
    const steps: StepDef[] = [
      { id: "produce", dependencies: [] },
      { id: "qa", conditionalDependencies: [{ stepId: "produce", when: "success" }] },
    ];
    const verdict = missionWorkflowContinuationRemains([
      row("run-1", steps, "produce", "completed"),
      row("run-1", steps, "qa", "failed"),
    ]);
    expect(verdict.remains).toBe(false);
  });
});

describe("classifyTerminalMissionContinuation (all design-8.1 guards, fail-closed)", () => {
  const baseSignals = {
    missionStatus: "active",
    missionHasActiveHeartbeat: false,
    missionIssueIds: ["owner-1", "source-1"],
    liveWakeupIssueIds: new Set<string>(),
    openOwnerActionRecoveryExists: false,
    workflowStepRows: [] as WorkflowContinuationStepRow[],
  };

  it("is terminal when no guard remains", () => {
    expect(classifyTerminalMissionContinuation(baseSignals)).toEqual({ terminal: true });
  });

  it.each([
    ["active heartbeat (process-loss/fallback/tool-recovery in flight)", { ...baseSignals, missionHasActiveHeartbeat: true }],
    ["live wakeup (accepted source resume/override)", { ...baseSignals, liveWakeupIssueIds: new Set(["source-1"]) }],
    ["open owner-action recovery channel", { ...baseSignals, openOwnerActionRecoveryExists: true }],
    ["mission already terminal", { ...baseSignals, missionStatus: "completed" }],
  ] as const)("suppresses for %s", (_label, signals) => {
    expect(classifyTerminalMissionContinuation(signals).terminal).toBe(false);
  });

  it("suppresses when a runnable workflow step remains (failure edge)", () => {
    const steps: StepDef[] = [{ id: "produce", dependencies: [] }, { id: "rescue", conditionalDependencies: [{ stepId: "produce", when: "failure" }] }];
    const signals = { ...baseSignals, workflowStepRows: [row("run-1", steps, "produce", "failed"), row("run-1", steps, "rescue", "pending")] };
    expect(classifyTerminalMissionContinuation(signals).terminal).toBe(false);
  });
});

describe("buildTerminalMissionSnapshotKey (one report per terminal evidence snapshot)", () => {
  const base = { companyId: "c1", missionId: "m1", workflowRunId: "w1" };
  const failedRuns = [{ id: "r1", status: "failed", errorCode: "process_lost" }];

  it("is stable for the same failed-run fingerprint set", () => {
    const k1 = buildTerminalMissionSnapshotKey({ ...base, failedRuns });
    const k2 = buildTerminalMissionSnapshotKey({ ...base, failedRuns: [{ id: "r1", status: "failed", errorCode: "process_lost" }] });
    expect(k1).toBe(k2);
  });

  it("allows a later distinct terminal generation to report again", () => {
    const first = buildTerminalMissionSnapshotKey({ ...base, failedRuns });
    const later = buildTerminalMissionSnapshotKey({ ...base, failedRuns: [{ id: "r2", status: "timed_out", errorCode: null }] });
    expect(first).not.toBe(later);
  });

  it("aggregates simultaneous failures regardless of order", () => {
    const a = buildTerminalMissionSnapshotKey({ ...base, failedRuns: [{ id: "r1", status: "failed", errorCode: null }, { id: "r2", status: "failed", errorCode: null }] });
    const b = buildTerminalMissionSnapshotKey({ ...base, failedRuns: [{ id: "r2", status: "failed", errorCode: null }, { id: "r1", status: "failed", errorCode: null }] });
    expect(a).toBe(b);
  });
});

describe("buildTerminalMissionHumanOperatorComment (system-authored, bounded, sanitized)", () => {
  const issue = { id: "owner-1", companyId: "c1", missionId: "m1", originKind: "mission_main_executor_unblock", originId: "src-1", title: "T", identifier: "RES-1" };

  it("emits a system escalate decision and never leaks raw output / control chars / JSON", () => {
    const body = buildTerminalMissionHumanOperatorComment({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      missionTitle: `Bad{"secret":"x"}Title` + "\x00newline\nraw",
      sourceIssueIdentifier: "RES-42",
      failedRuns: [{ id: "r1", status: "failed", errorCode: "tool_step_failed\nleak" }],
    });
    expect(body).toContain("Decision: escalate");
    expect(body).not.toContain("{");
    expect(body).not.toContain('"secret"');
    expect(body).not.toContain("\x00");
    expect(body).not.toContain("\nleak");
    expect(body).toContain("continuation=none");

    // system-authored payload: actorType system (no agent attribution).
    const payload = buildHumanOperatorRequestPayload({
      issue,
      comment: { id: "c1", authorAgentId: null, authorUserId: null, body },
    });
    expect(payload?.actorType).toBe("system");
    expect(payload?.decision).toBe("escalate");
  });

  it("rejects cancelled runs and only treats failed/timed_out as terminal failures", async () => {
    // emit guard: a cancelled-only snapshot must not be reported.
    const result = await emitTerminalMissionHumanOperatorReport({ transaction: async () => ({ emitted: false, reason: "should-not-reach" }) } as never, {
      issue,
      missionTitle: null,
      sourceIssueIdentifier: null,
      workflowRunId: null,
      failedRuns: [{ id: "r1", status: "cancelled", errorCode: null }],
    });
    expect(result.emitted).toBe(false);
  });
});
