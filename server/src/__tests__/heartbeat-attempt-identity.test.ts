import { expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { sameHeartbeatExecutionAttempt, heartbeatActualIdentityMatchesRun, producedExecutionScopeKind, sameC5ExecutionIdentityBeforeOwnerRelease } from "../services/heartbeat-attempt-identity.js";

it("rejects changes in every persisted execution-attempt identity field", () => {
  const keys = ["id", "companyId", "agentId", "issueId", "wakeupRequestId", "workflowStepRunId", "workflowExecutionGeneration", "executionScopeKind", "executionEpoch", "executionToken", "executorOwnerId", "executorOwnerLeaseEpoch", "executorOwnerLeaseToken", "retryOfRunId", "processLossRetryCount"] as const;
  const base = Object.fromEntries(keys.map((key) => [key, `value-${key}`]));
  const run = base as unknown as typeof heartbeatRuns.$inferSelect;
  expect(sameHeartbeatExecutionAttempt(run, { ...run })).toBe(true);
  for (const key of keys) {
    expect(sameHeartbeatExecutionAttempt(run, { ...run, [key]: `different-${key}` })).toBe(false);
  }
});


it("binds a drained actual to the exact persisted run and owner", () => {
  const pairs = { heartbeatRunId: "id", companyId: "companyId", issueId: "issueId", wakeupRequestId: "wakeupRequestId", workflowStepRunId: "workflowStepRunId", executionGeneration: "workflowExecutionGeneration", executionScopeKind: "executionScopeKind", executionEpoch: "executionEpoch", executionToken: "executionToken", executorOwnerId: "executorOwnerId", ownerLeaseEpoch: "executorOwnerLeaseEpoch", ownerLeaseToken: "executorOwnerLeaseToken", retryOfRunId: "retryOfRunId", processLossRetryCount: "processLossRetryCount" } as const;
  const identity = Object.fromEntries(Object.keys(pairs).map((key) => [key, `value-${key}`]));
  const run = Object.fromEntries(Object.entries(pairs).map(([identityKey, runKey]) => [runKey, identity[identityKey]]));
  const typedIdentity = identity as unknown as Parameters<typeof heartbeatActualIdentityMatchesRun>[0];
  const typedRun = run as unknown as typeof heartbeatRuns.$inferSelect;
  expect(heartbeatActualIdentityMatchesRun(typedIdentity, typedRun)).toBe(true);
  for (const key of Object.keys(pairs)) {
    expect(heartbeatActualIdentityMatchesRun({ ...typedIdentity, [key]: `different-${key}` }, typedRun)).toBe(false);
  }
});


it("preserves workflow, issue, mission and invocation scope precedence", () => {
  const run = { issueId: "issue", invocationSource: "timer" } as unknown as typeof heartbeatRuns.$inferSelect;
  const wake = { workflowStepRunId: "step", workflowExecutionGeneration: 0, missionId: "mission" } as unknown as NonNullable<Parameters<typeof producedExecutionScopeKind>[1]>;
  expect(producedExecutionScopeKind(run, wake)).toBe("workflow_step");
  expect(producedExecutionScopeKind(run, { ...wake, workflowExecutionGeneration: null })).toBe("issue_nonworkflow");
  expect(producedExecutionScopeKind({ ...run, issueId: null }, { ...wake, workflowStepRunId: null })).toBe("mission_nonworkflow");
  expect(producedExecutionScopeKind({ ...run, issueId: null }, null)).toBe("timer");
});


it("accepts only the owner-release transition for an otherwise identical C5 attempt", () => {
  const before = { executorOwnerReleasedAt: null, executorOwnerId: "owner", executionToken: "token" } as unknown as Parameters<typeof sameC5ExecutionIdentityBeforeOwnerRelease>[0];
  const released = { ...before, executorOwnerReleasedAt: new Date("2026-01-01T00:00:00Z") };
  expect(sameC5ExecutionIdentityBeforeOwnerRelease(before, released)).toBe(true);
  expect(sameC5ExecutionIdentityBeforeOwnerRelease(before, { ...released, executorOwnerId: "other" })).toBe(false);
  expect(sameC5ExecutionIdentityBeforeOwnerRelease(before, before)).toBe(false);
  expect(sameC5ExecutionIdentityBeforeOwnerRelease(before, { ...released, executorOwnerReleasedAt: new Date("invalid") })).toBe(false);
});
