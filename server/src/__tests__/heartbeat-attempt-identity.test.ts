import { expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { sameHeartbeatExecutionAttempt } from "../services/heartbeat-attempt-identity.js";

it("rejects changes in every persisted execution-attempt identity field", () => {
  const keys = ["id", "companyId", "agentId", "issueId", "wakeupRequestId", "workflowStepRunId", "workflowExecutionGeneration", "executionScopeKind", "executionEpoch", "executionToken", "executorOwnerId", "executorOwnerLeaseEpoch", "executorOwnerLeaseToken", "retryOfRunId", "processLossRetryCount"] as const;
  const base = Object.fromEntries(keys.map((key) => [key, `value-${key}`]));
  const run = base as unknown as typeof heartbeatRuns.$inferSelect;
  expect(sameHeartbeatExecutionAttempt(run, { ...run })).toBe(true);
  for (const key of keys) {
    expect(sameHeartbeatExecutionAttempt(run, { ...run, [key]: `different-${key}` })).toBe(false);
  }
});
