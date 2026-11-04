import { expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { sameHeartbeatExecutionAttempt, heartbeatActualIdentityMatchesRun } from "../services/heartbeat-attempt-identity.js";

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
