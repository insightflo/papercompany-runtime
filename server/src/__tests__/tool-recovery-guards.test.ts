import { describe, expect, it } from "vitest";
import { evaluateOwnerToolRecoverySnapshot } from "../services/missions/owner-tool-recovery-eligibility.js";
import { ownerRecoveryActorFailure, ownerRecoveryIdentityMatches, ownerRecoveryIssueFailure, ownerRecoveryRunMatches, ownerRecoveryStepMatches } from "../services/missions/owner-recovery-submission-guards.js";
import { isIssueLessToolStep } from "../services/workflow/issue-less-tool-shape.js";
import { isIssueLessToolWorkflowStep } from "../services/missions/tool-step-failure.js";
import { isWorkflowApiIssue } from "../services/workflow/issue-api-guards.js";

describe("shared recovery guards preserve execution semantics", () => {
  const target = { kind: "tool_step" as const, workflowRunId: "run", stepRunId: "step", expectedAuthorityVersion: 3,
    expectedExecutionGeneration: 4, failedDispatchRequestId: "request" };
  const issue = { id: "card", companyId: "company", missionId: "mission", originId: "source", originKind: "mission_main_executor_unblock" };
  const actor = { actorType: "agent" as const, actorId: "owner", agentId: "owner", runId: "heartbeat" };
  it("keeps submission authentication, heartbeat identity and workflow registration distinct", () => {
    expect(ownerRecoveryActorFailure({ ...actor, actorType: "user", runId: null })).toBe("agent_required");
    expect(ownerRecoveryActorFailure({ ...actor, runId: null })).toBe("run_required");
    expect(ownerRecoveryIssueFailure({ originKind: "workflow_execution", missionId: null })).toBe("unblock_required");
    expect(ownerRecoveryIssueFailure({ ...issue, missionId: null })).toBe("mission_required");
    expect(ownerRecoveryIdentityMatches({ issue, currentIssue: issue, agentId: "owner",
      heartbeat: { companyId: "company", agentId: "owner", issueId: "card" } })).toBe(true);
    expect(ownerRecoveryIdentityMatches({ issue, currentIssue: issue, agentId: "owner",
      heartbeat: { companyId: "company", agentId: "owner", issueId: "source" } })).toBe(false);
    expect(isWorkflowApiIssue(issue)).toBe(false);
    expect(isWorkflowApiIssue({ originKind: "workflow_execution" })).toBe(true);
  });
  it("target matching does not invent execution permission or normalize request identities", () => {
    expect(ownerRecoveryRunMatches({ status: "failed", dispatchAuthorityVersion: 3 }, target)).toBe(true);
    expect(ownerRecoveryRunMatches({ status: "running", dispatchAuthorityVersion: 3 }, target)).toBe(false);
    expect(ownerRecoveryStepMatches({ status: "failed", executionGeneration: 4, lastDispatchRequestId: "request " }, target)).toBe(false);
    expect(ownerRecoveryStepMatches({ status: "failed", executionGeneration: 4, lastDispatchRequestId: "request" }, target)).toBe(true);
  });
  it("does not unify the broader mission ownership predicate with canonical DAG eligibility", () => {
    const legacy = { id: "tool", name: "tool", dependencies: [], type: "tool" as const, agentId: "", toolName: "legacy" };
    expect(isIssueLessToolWorkflowStep(legacy, null)).toBe(true);
    expect(isIssueLessToolStep(legacy)).toBe(false);
    expect(isIssueLessToolStep({ ...legacy, toolNames: ["canonical"] })).toBe(true);
    expect(isIssueLessToolStep({ ...legacy, toolNames: ["canonical"], agentName: "worker" } as never)).toBe(false);
  });
  it("keeps ordered null/no-op checks and never uses prose as an inferred target", () => {
    const base = { mission: { id: "mission", companyId: "company", ownerAgentId: "owner" }, issue,
      sourceIssue: { originKind: "mission_main_executor_oversight" }, stepRows: [], decision: null, toolCard: true, qaCard: false, apply: false };
    expect(evaluateOwnerToolRecoverySnapshot(base)).toEqual({ kind: "blocked", reason: "target_missing", outcome: "requires_decision" });
    expect(evaluateOwnerToolRecoverySnapshot({ ...base, toolCard: false, qaCard: true })).toEqual({ kind: "not_applicable" });
    const decision = { eventId: "event", createdAt: new Date(), ownerActionIssueId: "card", missionId: "mission", sourceIssueId: "source",
      heartbeatRunId: "heartbeat", authorAgentId: "wrong", commentId: null, decision: { decision: "retry_source_issue" as const, recoveryTarget: target } };
    expect(evaluateOwnerToolRecoverySnapshot({ ...base, decision })).toEqual({ kind: "blocked", reason: "decision_scope_mismatch", outcome: "blocked" });
    expect(evaluateOwnerToolRecoverySnapshot({ ...base, decision: { ...decision, authorAgentId: "owner" } })).toEqual({ kind: "blocked", reason: "no_step_run", outcome: "blocked" });
  });
});
