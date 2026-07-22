import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

const LIVE_HEARTBEAT_STATUSES = ["queued", "running"] as const;
const DIRECT_LIVE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;

export interface WorkflowRetryExecutionStateInput {
  companyId: string;
  issueId: string;
}

export interface WorkflowRetryWakeEvidenceInput {
  companyId: string;
  issueId: string;
  workflowRunId: string;
  stepRunId: string;
  idempotencyKey: string;
}

export interface WorkflowRetryWakeEvidence {
  wakeupRequestId: string;
  status: string;
  runId: string | null;
}

/**
 * Generic retry must stay suppressed while an accepted heartbeat recovery or live
 * wake request already covers the same company-scoped issue. Coalesced wakeups are
 * live only when their linked heartbeat run is still queued/running.
 */
export async function hasActiveWorkflowRetryRecoveryExecution(
  db: Db,
  input: WorkflowRetryExecutionStateInput,
): Promise<boolean> {
  const [activeHeartbeat] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, input.issueId),
      inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
    ))
    .limit(1);

  if (activeHeartbeat) return true;

  const wakeRows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, input.issueId),
      inArray(agentWakeupRequests.status, [...DIRECT_LIVE_WAKEUP_STATUSES, "coalesced"]),
    ));

  if (wakeRows.some((row) => row.status !== "coalesced")) return true;

  const coalescedRunIds = wakeRows
    .filter((row) => row.status === "coalesced" && row.runId)
    .map((row) => row.runId!);
  if (coalescedRunIds.length === 0) return false;

  const [liveCoalescedRun] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.id, coalescedRunIds),
      inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
    ))
    .limit(1);

  return Boolean(liveCoalescedRun);
}

export async function findAcceptedWorkflowRetryWakeEvidence(
  db: Db,
  input: WorkflowRetryWakeEvidenceInput,
): Promise<WorkflowRetryWakeEvidence | null> {
  const wakeRows = await db
    .select({
      wakeupRequestId: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, input.issueId),
      eq(agentWakeupRequests.workflowRunId, input.workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, input.stepRunId),
      eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      inArray(agentWakeupRequests.status, [...DIRECT_LIVE_WAKEUP_STATUSES, "coalesced"]),
    ));

  const directWake = wakeRows.find((row) =>
    [...DIRECT_LIVE_WAKEUP_STATUSES].includes(row.status as (typeof DIRECT_LIVE_WAKEUP_STATUSES)[number]),
  );
  if (directWake) return directWake;

  const coalescedRunIds = wakeRows
    .filter((row) => row.status === "coalesced" && row.runId)
    .map((row) => row.runId!);
  if (coalescedRunIds.length === 0) return null;

  const [liveRun] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.id, coalescedRunIds),
      inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
    ))
    .limit(1);

  if (!liveRun) return null;
  return wakeRows.find((row) => row.runId === liveRun.id) ?? null;
}
