import type { HeartbeatRunSummary } from "@paperclipai/shared";

/** Minimal stub for a direct-linked run outside the loaded page. */
export function createDirectLinkedRunStub(
  runId: string,
  companyId: string,
  agentId: string,
): HeartbeatRunSummary {
  return {
    id: runId, companyId, agentId,
    invocationSource: "on_demand" as const, triggerDetail: null,
    status: "queued" as const, startedAt: null, finishedAt: null,
    error: null, errorCode: null, exitCode: null, signal: null,
    usageJson: null, resultSummary: null, issueId: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  };
}
