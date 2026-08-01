import { describe, expect, it } from "vitest";
import { deriveOperatorDecisionContinuationStatus } from "../services/operator-decision-view.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const baseContinuation = {
  state: "accepted",
  errorCode: null,
  nextAttemptAt: new Date("2026-07-29T12:00:00.000Z"),
  leaseExpiresAt: null,
  targetAgentId: "agent-1",
};
const baseWakeup = { status: "queued", runId: null };
const baseIssue = { id: "issue-1", status: "todo", assigneeAgentId: "agent-1" };
const baseAgent = { id: "agent-1", status: "idle" };

function derive(overrides: Record<string, unknown> = {}) {
  return deriveOperatorDecisionContinuationStatus({
    continuation: { ...baseContinuation, ...(overrides.continuation as object ?? {}) } as never,
    wakeup: overrides.wakeup === undefined ? baseWakeup as never : overrides.wakeup as never,
    run: overrides.run === undefined ? null : overrides.run as never,
    issue: overrides.issue === undefined ? baseIssue : overrides.issue as never,
    targetAgent: overrides.targetAgent === undefined ? baseAgent : overrides.targetAgent as never,
    now,
  });
}

const cases: Array<[string, Record<string, unknown>, string, string | null, boolean]> = [
  ["outbox blocked", { continuation: { state: "blocked", errorCode: "issue_missing" } }, "blocked", "issue_missing", true],
  ["outbox exhausted", { continuation: { state: "exhausted" } }, "exhausted", "attempts_exhausted", true],
  ["overdue pending", { continuation: { state: "pending", nextAttemptAt: new Date("2026-07-29T11:59:29Z") } }, "pending", "dispatch_delayed", true],
  ["failed dispatch backoff", { continuation: { state: "pending", errorCode: "dispatch_failed" } }, "pending", "dispatch_failed", false],
  ["fresh pending", { continuation: { state: "pending" } }, "pending", null, false],
  ["expired lease", { continuation: { state: "leased", leaseExpiresAt: new Date("2026-07-29T11:59:59Z") } }, "dispatching", "lease_expired", true],
  ["active lease", { continuation: { state: "leased", leaseExpiresAt: new Date("2026-07-29T12:00:01Z") } }, "dispatching", null, false],
  ["accepted proof missing", { wakeup: null }, "blocked", "proof_missing", true],
  ["run succeeded", { run: { status: "succeeded" } }, "completed", null, false],
  ["run failed", { run: { status: "failed" } }, "failed", "heartbeat_failed", true],
  ["run cancelled", { run: { status: "cancelled" } }, "cancelled", "heartbeat_cancelled", true],
  ["run timed out", { run: { status: "timed_out" } }, "timed_out", "heartbeat_timed_out", true],
  ["request completed", { wakeup: { status: "completed", runId: null } }, "completed", null, false],
  ["request skipped", { wakeup: { status: "skipped", runId: null } }, "skipped", "heartbeat_skipped", true],
  ["coalesced run", { wakeup: { status: "coalesced", runId: "run" }, run: { status: "running" } }, "coalesced", null, false],
  ["claimed run", { wakeup: { status: "claimed", runId: "run" }, run: { status: "queued" } }, "running", null, false],
  ["claimed without run", { wakeup: { status: "claimed", runId: null } }, "blocked", "proof_missing", true],
  ["missing issue guard", { issue: null }, "blocked", "issue_missing", true],
  ["unassigned guard", { issue: { ...baseIssue, assigneeAgentId: null } }, "blocked", "issue_unassigned", true],
  ["terminal issue guard", { issue: { ...baseIssue, status: "done" } }, "issue_terminal", "issue_terminal", true],
  ["assignee changed guard", { issue: { ...baseIssue, assigneeAgentId: "agent-2" } }, "assignee_changed", "assignee_changed", true],
  ["paused target guard", { targetAgent: { ...baseAgent, status: "paused" } }, "agent_unrunnable", "agent_unrunnable", true],
  ["deferred request", { wakeup: { status: "deferred_issue_execution", runId: null } }, "deferred", null, false],
  ["unknown status fails closed", { wakeup: { status: "future_status", runId: null } }, "blocked", "proof_missing", true],
];

describe("operator decision continuation effective status", () => {
  it.each(cases)("maps %s", (_name, overrides, effectiveStatus, errorCode, attention) => {
    expect(derive(overrides)).toEqual({ effectiveStatus, errorCode, attention });
  });

  it("lets terminal run state outrank later issue guards", () => {
    expect(derive({
      run: { status: "succeeded" },
      issue: null,
      targetAgent: null,
    })).toEqual({ effectiveStatus: "completed", errorCode: null, attention: false });
  });
});
