import { describe, expect, it } from "vitest";
import {
  classifyRecoveryRole,
  resolveMissionRecoveryAdvice,
  type IssueForAdvice,
  type PlanQaVerdictForAdvice,
  type ValidationVerdictForAdvice,
  type WorkProductForAdvice,
  type WorkflowStepForAdvice,
} from "../services/missions/mission-recovery-advice.js";

// Structured verdict authority only — no comment input on the pure resolver.

const T0 = new Date("2026-07-07T00:00:00Z");
const T1 = new Date("2026-07-07T01:00:00Z");
const T2 = new Date("2026-07-07T02:00:00Z");

function makeProducer(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "p-1076",
    identifier: "RES-1076",
    title: "Collect bounded TechCrunch AI evidence",
    status: "done",
    originKind: "workflow_execution",
    originId: null,
    assigneeAgentId: "agent-producer",
    updatedAt: T0,
    ...overrides,
  };
}

function makeQa(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "q-1077",
    identifier: "RES-1077",
    title: "Audit source coverage and confidence",
    status: "done",
    originKind: "mission_plan_qa",
    originId: "p-1076",
    assigneeAgentId: "agent-qa",
    updatedAt: T1,
    ...overrides,
  };
}

function makeOversight(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "o-1075",
    identifier: "RES-1075",
    title: "mission owner oversight",
    status: "todo",
    originKind: "mission_main_executor_oversight",
    originId: null,
    assigneeAgentId: null,
    updatedAt: T0,
    ...overrides,
  };
}

function planQaRequestChanges(overrides: Partial<PlanQaVerdictForAdvice> = {}): PlanQaVerdictForAdvice {
  return {
    issueId: "q-1077",
    verdict: "request_changes",
    reason: "missing TechCrunch AI category sources including Cloudflare, Gemini Spark, and Meta Pocket.",
    observedAt: T1,
    decisionHash: "hash-active",
    sourceCommentId: null,
    ...overrides,
  };
}

function workflowRequestChanges(overrides: Partial<ValidationVerdictForAdvice> = {}): ValidationVerdictForAdvice {
  return {
    issueId: "q-1077",
    verdict: "request_changes",
    reason: "missing TechCrunch AI category sources including Cloudflare, Gemini Spark, and Meta Pocket.",
    observedAt: T1,
    workflowRunId: "run-1",
    workflowStepRunId: "step-qa-1",
    heartbeatRunId: "hb-qa-1",
    ...overrides,
  };
}

function makeWorkProduct(overrides: Partial<WorkProductForAdvice> = {}): WorkProductForAdvice {
  return {
    id: "wp-1",
    issueId: "p-1076",
    title: "evidence.json",
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function workflowStepsForAuditLoop(overrides: {
  qaStepRunId?: string;
  runId?: string;
} = {}): WorkflowStepForAdvice[] {
  const runId = overrides.runId ?? "run-1";
  const qaStepRunId = overrides.qaStepRunId ?? "step-qa-1";
  return [
    {
      workflowRunId: runId,
      workflowStepRunId: "step-prod-1",
      stepId: "collect-ai-news-evidence",
      issueId: "p-1076",
      status: "completed",
      dependencies: [],
      conditionalDependencies: [
        { stepId: "audit-source-coverage", when: "qa_request_changes", isBackEdge: true },
      ],
    },
    {
      workflowRunId: runId,
      workflowStepRunId: qaStepRunId,
      stepId: "audit-source-coverage",
      issueId: "q-1077",
      status: "failed",
      dependencies: ["collect-ai-news-evidence"],
      conditionalDependencies: [],
    },
  ];
}

describe("classifyRecoveryRole", () => {
  it("maps originKind to producer/qa/oversight/planning", () => {
    expect(classifyRecoveryRole("mission_plan_qa")).toBe("qa");
    expect(classifyRecoveryRole("mission_main_executor_oversight")).toBe("oversight");
    expect(classifyRecoveryRole("mission_main_executor_unblock")).toBe("oversight");
    expect(classifyRecoveryRole("mission_main_executor_plan")).toBe("planning");
    expect(classifyRecoveryRole("workflow_execution")).toBe("producer");
    expect(classifyRecoveryRole("manual")).toBe("producer");
  });
});

describe("resolveMissionRecoveryAdvice", () => {
  it("structured PLAN-QA request_changes drives producer_rework", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer(), makeQa(), makeOversight()],
      planQaVerdicts: [planQaRequestChanges()],
      runs: [],
    });
    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.id).toBe("p-1076");
    expect(advice.leafCause).toContain("Cloudflare");
    expect(advice.operatorComment).toContain("RES-1076");
  });

  it("producer workProduct after PLAN-QA request → qa_recheck", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ updatedAt: T2 }), makeQa(), makeOversight()],
      planQaVerdicts: [planQaRequestChanges()],
      runs: [],
      workProducts: [makeWorkProduct({ updatedAt: T2 })],
    });
    expect(advice.decision).toBe("qa_recheck");
    expect(advice.targetIssue?.id).toBe("q-1077");
  });

  it("workflow QA request_changes resolves producer via back-edge", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [
        makeProducer({ originId: "run-1" }),
        makeQa({ originKind: "workflow_execution", originId: "run-1" }),
        makeOversight(),
      ],
      validationVerdicts: [
        workflowRequestChanges({
          reason: "Remaining issue: two late-2026-07-06 AI-category sources are missing.",
        }),
      ],
      runs: [],
      workflowSteps: workflowStepsForAuditLoop(),
    });
    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.identifier).toBe("RES-1076");
    expect(advice.leafCause).toContain("late-2026-07-06");
  });

  it("stale older-run workflow request_changes is ignored for current step", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [
        makeProducer({ originId: "run-2" }),
        makeQa({ originKind: "workflow_execution", originId: "run-2" }),
        makeOversight(),
      ],
      validationVerdicts: [
        workflowRequestChanges({
          workflowRunId: "run-1",
          workflowStepRunId: "step-qa-1",
          observedAt: T2,
          reason: "stale older-run request_changes",
        }),
      ],
      runs: [],
      workflowSteps: workflowStepsForAuditLoop({ runId: "run-2", qaStepRunId: "step-qa-2" }),
    });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
  });

  it("later PASS on same current workflow step suppresses earlier request_changes", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [
        makeProducer({ originId: "run-1" }),
        makeQa({ originKind: "workflow_execution", originId: "run-1" }),
        makeOversight(),
      ],
      validationVerdicts: [
        workflowRequestChanges({
          observedAt: T1,
          reason: "earlier request_changes with a concrete reason",
        }),
        {
          issueId: "q-1077",
          verdict: "pass",
          reason: "later pass",
          observedAt: T2,
          workflowRunId: "run-1",
          workflowStepRunId: "step-qa-1",
          heartbeatRunId: "hb-qa-2",
        },
      ],
      runs: [],
      workflowSteps: workflowStepsForAuditLoop(),
    });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
  });

  it("later PLAN-QA pass suppresses earlier request_changes", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer(), makeQa(), makeOversight()],
      planQaVerdicts: [
        planQaRequestChanges({ observedAt: T1, reason: "earlier plan-qa request_changes" }),
        {
          issueId: "q-1077",
          verdict: "pass",
          reason: null,
          observedAt: T2,
          decisionHash: "hash-active",
          sourceCommentId: null,
        },
      ],
      runs: [],
    });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
  });

  it("legacy sourceCommentId PLAN-QA row has no authority", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer(), makeQa(), makeOversight()],
      planQaVerdicts: [
        planQaRequestChanges({
          sourceCommentId: "comment-legacy-1",
          reason: "legacy comment-derived must not drive recovery",
        }),
      ],
      runs: [],
    });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
  });

  it("no structured request_changes + stuck issue → supervision_run", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "in_progress", originId: null }), makeOversight()],
      runs: [],
    });
    expect(advice.decision).toBe("supervision_run");
    expect(advice.targetIssue?.id).toBe("p-1076");
  });

  it("no structured request_changes + no stuck issue → human_operator", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "done" }), makeOversight({ status: "done" })],
      runs: [],
    });
    expect(advice.decision).toBe("human_operator");
    expect(advice.targetIssue).toBeNull();
  });
});
