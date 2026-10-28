import { describe, expect, it } from "vitest";
import {
  buildHumanOperatorRequestPayload,
} from "../services/missions/human-operator-alert-events.js";
import {
  buildTerminalMissionHumanOperatorComment,
  buildTerminalMissionSnapshotKey,
  classifyTerminalMissionContinuation,
  emitTerminalMissionHumanOperatorReport,
  reviewedResumePolicyFullyResolves,
  terminalResumeGuidanceText,
  terminalCardStructuredOptions,
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

    // [fail-closed] comment-only input is NOT authority: the builder now requires a structured record
    //   (eventId + proven authorAgentId). The terminal system path builds its own system payload with a
    //   transition-event decisionEventId directly — a comment body must not materialize an alert.
    const payload = buildHumanOperatorRequestPayload({
      issue,
      comment: { id: "c1", authorAgentId: null, authorUserId: null, body },
    });
    expect(payload).toBeNull();
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
// [재개 경로 안내 2026-10-23] 검토된 재개 정책이 온전히 resolve 되는 경우에만 실제 클릭 경로를 안내한다.
describe("terminal resume guidance (reviewed resume policy surfacing)", () => {
  it("terminalResumeGuidanceText returns null unless a reviewed path is available", () => {
    expect(terminalResumeGuidanceText(false, "ko")).toBeNull();
    expect(terminalResumeGuidanceText(false, "en")).toBeNull();
    expect(terminalResumeGuidanceText(true, "ko")).toContain("이 실행 이어서 진행");
    expect(terminalResumeGuidanceText(true, "en")).toContain("resume");
  });

  it("reviewedResumePolicyFullyResolves requires every binding to resolve against current rows", () => {
    const registryRows = [
      { id: "tool-1", enabled: true, updatedAt: new Date("2026-10-02T00:02:12.308Z"),
        name: "manual-onboarding-qa", adapterType: "builtin", adapterConfig: { a: 1 }, inputSchema: null },
    ] as never as (typeof import("@paperclipai/db").toolDefinitions.$inferSelect)[];
    const policy = {
      schemaVersion: 1 as const, companyId: "c1", definitionHash: "h".repeat(64),
      steps: {
        "qa-gate": { effect: "none" as const, toolBindings: [{ id: "tool-1", updatedAt: "2026-10-02T00:02:12.308Z", configHash: "deadbeef" }] },
        "agent-step": { effect: "none" as const, toolBindings: [] },
      },
      requiredGateStepIds: ["qa-gate"], publicationStepIds: [], generationStepIds: [],
    };
    // binding configHash does not match the row → not fully resolved → no guidance.
    expect(reviewedResumePolicyFullyResolves(policy, registryRows)).toBe(false);
    const bindingFree = { ...policy, steps: { "agent-step": { effect: "none" as const, toolBindings: [] } } };
    expect(reviewedResumePolicyFullyResolves(bindingFree, registryRows)).toBe(true);
  });

  it("comment appends the resume path line only when guidance is provided", () => {
    const base = {
      issueId: "owner-1", issueIdentifier: "RES-1", missionTitle: "T", sourceIssueIdentifier: "RES-42",
      failedRuns: [{ id: "r1", status: "failed", errorCode: null }] as const,
    };
    expect(buildTerminalMissionHumanOperatorComment(base)).not.toContain("Resume path:");
    expect(buildTerminalMissionHumanOperatorComment({ ...base, resumeGuidance: terminalResumeGuidanceText(true, "ko") }))
      .toContain("Resume path: 이 미션의 실패 실행은 검토된 재개 경로가 있습니다");
  });
});

// [승인=재개 2026-10-23] 재개 옵션 구성 — 재개 가능할 때만 첫 옵션+추천으로 추가.
describe("terminalCardStructuredOptions (resume option on the terminal card)", () => {
  it("returns an explicit external-input block when no direct command is eligible", () => {
    expect(terminalCardStructuredOptions(false, false)).toMatchObject({
      structuredOptions: [{ id: "missing-recovery-target" }],
      recommendedOptionId: "missing-recovery-target",
    });
  });
  it("offers only verified direct commands and never derives commands from prose", () => {
    const options = terminalCardStructuredOptions(true, true);
    expect(options.structuredOptions[0]).toMatchObject({ id: "resume-this-run" });
    expect(options.structuredOptions[0]!.label).toContain("이 실행 이어서 진행");
    expect(options.structuredOptions.map((o) => o.id)).toEqual([
      "resume-this-run", "restart-workflow-from-start",
    ]);
    expect(options.recommendedOptionId).toBe("resume-this-run");
  });
});
