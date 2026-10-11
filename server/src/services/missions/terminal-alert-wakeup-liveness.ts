import type {
  MissionSupervisionHeartbeatRun,
  MissionSupervisionIssue,
} from "./mission-supervision-context.js";

type WakeupRow = {
  issueId: string | null;
  status: string;
  runId: string | null;
  createdAt: Date;
  requestedAt: Date;
  updatedAt: Date;
};

type ScopedIssue = Pick<
  MissionSupervisionIssue,
  "id" | "originKind" | "checkoutRunId" | "executionRunId" | "executionLockedAt"
>;

const LIVE_HEARTBEAT_RUN_STATUSES = new Set(["queued", "running"]);
const ENDED_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/**
 * Builds the wakeups that still suppress a terminal human-operator alert.
 * This is deliberately alert-only; execution, wakeup rows, and the shared
 * stopped-execution liveness set remain unchanged.
 */
export function buildTerminalAlertLiveWakeupIssueIds(input: {
  wakeups: readonly WakeupRow[];
  missionIssueById: ReadonlyMap<string, ScopedIssue>;
  heartbeatRunsByIssueId: ReadonlyMap<string, readonly MissionSupervisionHeartbeatRun[]>;
}): Set<string> {
  const result = new Set<string>();

  for (const wakeup of input.wakeups) {
    if (!wakeup.issueId) continue;
    const issue = input.missionIssueById.get(wakeup.issueId);
    if (!issue) continue;

    const runs = input.heartbeatRunsByIssueId.get(issue.id) ?? [];
    const linked = runs.find((run) => run.id === wakeup.runId && run.issueId === issue.id);
    const lastRequestAt = Math.max(
      wakeup.createdAt.getTime(),
      wakeup.requestedAt.getTime(),
      wakeup.updatedAt.getTime(),
    );
    const terminalReceipt = wakeup.status === "coalesced"
      && linked !== undefined
      && ENDED_HEARTBEAT_RUN_STATUSES.has(linked.status);
    const strandedOversightDeferred = wakeup.status === "deferred_issue_execution"
      && issue.originKind === "mission_main_executor_oversight"
      && wakeup.runId === null
      && !issue.checkoutRunId
      && !issue.executionRunId
      && !issue.executionLockedAt
      && !runs.some((run) => run.issueId === issue.id && LIVE_HEARTBEAT_RUN_STATUSES.has(run.status))
      && runs.some((run) => run.issueId === issue.id
        && ENDED_HEARTBEAT_RUN_STATUSES.has(run.status)
        && run.finishedAt !== null
        && run.finishedAt.getTime() > lastRequestAt);

    if (!terminalReceipt && !strandedOversightDeferred) result.add(issue.id);
  }

  return result;
}
