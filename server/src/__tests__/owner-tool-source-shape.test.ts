import { describe, expect, it } from "vitest";
import { classifyOwnerToolSourceFacts } from "../services/missions/owner-tool-recovery-eligibility.js";

/**
 * Pure classifier regression for the PR457 canonical-shape mismatch: the source-fact
 * classifier must accept exactly the canonical issue-less tool shape the shared DAG
 * predicate (issue-less-tool-shape.ts) accepts — including steps whose persisted type is
 * omitted — while scope, exact step id, null-issue, dispatch settlement and success
 * evidence holds stay exact. failed_source stays observational only; nothing here grants
 * retry or artifact authority. Fixtures are synthetic identity/authority actuals cast the
 * same way tool-recovery-guards.test.ts casts shape fixtures; no DB or runtime state.
 */
const mission = { id: "mission", companyId: "company" };
const completedAtIso = "2026-10-30T19:22:22.732Z";
const successEvidence = () => ({
  toolResult: { success: true, requestId: "request", completedAt: completedAtIso },
  toolInvocation: { requestId: "request" },
  toolQueue: { status: "settled", settledAt: completedAtIso },
});
const run = (overrides: Record<string, unknown> = {}) =>
  ({ id: "run", companyId: "company", missionId: "mission", dispatchAuthorityVersion: 3, ...overrides }) as never;
const stepRun = (overrides: Record<string, unknown> = {}) =>
  ({ id: "step-run", workflowRunId: "run", stepId: "tool-step", issueId: null, status: "failed",
    executionGeneration: 4, lastDispatchRequestId: "request", metadata: {}, completedAt: null, ...overrides }) as never;
const step = (overrides: Record<string, unknown> = {}) =>
  ({ id: "tool-step", name: "tool", dependencies: [], agentId: "", toolNames: ["canonical"], ...overrides }) as never;
const classify = (stepOverrides: Record<string, unknown>, runOverrides: Record<string, unknown> = {},
  stepRunOverrides: Record<string, unknown> = {}) =>
  classifyOwnerToolSourceFacts({ mission: mission as never, run: run(runOverrides),
    stepRun: stepRun(stepRunOverrides), step: step(stepOverrides) });
const held = (reason: string) => ({ kind: "held", reason });

describe("classifyOwnerToolSourceFacts accepts the shared canonical issue-less tool shape", () => {
  it("classifies an omitted-type canonical step (toolNames + empty agent) instead of holding it", () => {
    expect(classify({ type: undefined })).toEqual({ kind: "failed_source" });
  });
  it("keeps explicit-type canonical tool steps on the same branch", () => {
    expect(classify({ type: "tool" })).toEqual({ kind: "failed_source" });
  });
  it("accepts the shared predicate's supported normalization (trimmed type/agentId, padded toolNames)", () => {
    expect(classify({ type: " Tool ", agentId: "   ", toolNames: [" canonical "] })).toEqual({ kind: "failed_source" });
  });
  it("recovers a completed omitted-type step only with exactly aligned success evidence", () => {
    expect(classify({ type: undefined }, {}, { status: "completed", completedAt: new Date(completedAtIso),
      metadata: successEvidence() })).toEqual({ kind: "source_recovered", requestId: "request",
      completedAt: completedAtIso, authorityVersion: 3, executionGeneration: 4 });
  });
});

describe("non-canonical and mis-scoped sources stay held", () => {
  const notCanonical = held("source_not_canonical_issue_less_tool");
  it("holds agent-typed steps", () => {
    expect(classify({ type: "agent" })).toEqual(notCanonical);
  });
  it("holds steps with a non-empty agentId or agentName", () => {
    expect(classify({ type: undefined, agentId: "worker" })).toEqual(notCanonical);
    expect(classify({ type: "tool", agentName: "worker" })).toEqual(notCanonical);
  });
  it("holds singular legacy toolName or missing toolNames", () => {
    expect(classify({ type: "tool", toolNames: undefined, toolName: "legacy" })).toEqual(notCanonical);
    expect(classify({ type: "tool", toolNames: undefined })).toEqual(notCanonical);
  });
  it("keeps the exact step-id and null-issue checks", () => {
    expect(classify({ id: "other-step" })).toEqual(notCanonical);
    expect(classify({ type: undefined }, {}, { issueId: "card" })).toEqual(notCanonical);
  });
  it("keeps the exact scope checks", () => {
    expect(classify({ type: undefined }, { companyId: "other" })).toEqual(held("source_scope_mismatch"));
    expect(classify({ type: undefined }, { missionId: "other" })).toEqual(held("source_scope_mismatch"));
    expect(classify({ type: undefined }, {}, { workflowRunId: "other-run" })).toEqual(held("source_scope_mismatch"));
  });
});

describe("observation never becomes execution authority", () => {
  it("returns failed_source observation only, without retry or artifact grant", () => {
    expect(classify({ type: undefined })).toEqual({ kind: "failed_source" });
  });
  it("holds unsettled or completed-without-evidence sources", () => {
    expect(classify({ type: undefined }, {}, { status: "running" })).toEqual(held("source_execution_unsettled"));
    expect(classify({ type: undefined }, {}, { status: "completed", completedAt: new Date(completedAtIso),
      metadata: {} })).toEqual(held("source_success_evidence_missing"));
  });
  it("holds completed sources whose dispatch settlement or success metadata does not align", () => {
    const evidence = successEvidence();
    expect(classify({ type: undefined }, {}, { status: "completed", completedAt: new Date(completedAtIso),
      metadata: { ...evidence, toolResult: { ...evidence.toolResult, requestId: "stale" } } }))
      .toEqual(held("source_success_evidence_mismatch"));
  });
});
