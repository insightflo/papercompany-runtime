// server/src/services/missions/qa-rework-cap-oversight-wake.ts
//
// [ purpose ] Wake dispatch + authoritative outcome verification for QA cap oversight.
//   Never treats a resolved callback as queue proof: after calling the owner-action wake,
//   it ALWAYS verifies the actual agentWakeupRequests/heartbeatRuns outcome from the DB.
//   On repeated supervision, if a live/accepted wake already covers the issue → no-op.
//   Missing/failed → let the failure propagate (supervision retries next tick).
//
//   Liveness rules (mirrors owner-action-unblock-handback.ts with coalesced fix):
//     - queued/claimed/deferred_issue_execution → always live (pending request).
//     - coalesced → live ONLY if the linked heartbeat run is queued/running.
//       A terminal coalesced-run means the wake was consumed → must re-wake.

import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, workflowTransitionEvents } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import type { MissionRow } from "../missions.js";
import type { MissionServiceDeps } from "../missions.js";
import type { IssueRow } from "./shared-types.js";

/** Request statuses that indicate pending work (coalesced handled separately). */
const DIRECT_LIVE_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;

export type CapWakeOutcome = "dispatched" | "covered" | "failed";

/** Accepted heartbeat run statuses. */
const ACCEPTED_RUN_STATUSES = ["queued", "running"] as const;


/**
 * True if a live wake request OR accepted heartbeat run already covers `issueId`.
 * Coalesced requests are only live when their linked run is queued/running.
 */
export async function hasLiveWakeCoverage(
  db: Db, companyId: string, issueId: string,
): Promise<boolean> {
  const requests = await db.select({
    id: agentWakeupRequests.id,
    status: agentWakeupRequests.status,
    runId: agentWakeupRequests.runId,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId),
    eq(agentWakeupRequests.issueId, issueId),
    inArray(agentWakeupRequests.status, [...DIRECT_LIVE_STATUSES, "coalesced"]),
  ));

  // Direct live statuses (queued/claimed/deferred) = always covered.
  const hasDirect = requests.some((r) => r.status !== "coalesced");
  if (hasDirect) return true;

  // Coalesced: covered only if linked run is queued/running.
  const coalescedRunIds = requests
    .filter((r) => r.status === "coalesced" && r.runId)
    .map((r) => r.runId!);
  if (coalescedRunIds.length > 0) {
    const liveCoalescedRun = await db.select({ id: heartbeatRuns.id })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.id, coalescedRunIds),
        inArray(heartbeatRuns.status, [...ACCEPTED_RUN_STATUSES]),
      )).limit(1);
    if (liveCoalescedRun.length > 0) return true;
  }

  // Also check direct accepted heartbeat runs for this issue.
  const liveRun = await db.select({ id: heartbeatRuns.id })
    .from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.issueId, issueId),
      inArray(heartbeatRuns.status, [...ACCEPTED_RUN_STATUSES]),
    )).limit(1);
  return liveRun.length > 0;
}

/** Append-only history record of each wake attempt outcome (never overwrites). */
export async function recordCapWakeOutcome(db: Db, input: {
  companyId: string; missionId: string; issueId: string;
  workflowRunId: string; keyHash: string; outcome: CapWakeOutcome;
}): Promise<void> {
  const idempotencyKey = `qa-cap-wake:${input.keyHash}:${input.outcome}:${Date.now()}`;
  await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.issueId,
    workflowRunId: input.workflowRunId,
    eventType: "qa_cap_oversight_wake",
    layer: "workflow_validation",
    decision: input.outcome,
    idempotencyKey,
    payload: { kind: "qa_cap_oversight_wake", outcome: input.outcome, keyHash: input.keyHash },
  }).onConflictDoNothing();
}

/**
 * Dispatch the owner-action wake for a cap oversight issue. Performs a live-coverage
 * check first (no-op if already covered), calls the callback, then ALWAYS verifies
 * the authoritative DB outcome — a resolved callback alone is never queue proof.
 */
export async function dispatchCapWake(input: {
  db: Db; mission: MissionRow; issue: IssueRow; oversightIssue: IssueRow;
  workflowRunId: string; keyHash: string;
  onOwnerActionCreated: NonNullable<MissionServiceDeps["onOwnerActionCreated"]>;
}): Promise<void> {
  const { db, mission, issue, oversightIssue, keyHash } = input;
  const companyId = mission.companyId;
  const record = (outcome: CapWakeOutcome) => recordCapWakeOutcome(db, {
    companyId, missionId: mission.id, issueId: issue.id,
    workflowRunId: input.workflowRunId, keyHash, outcome,
  });

  // 1. If a live/accepted wake already covers this issue → no-op.
  if (await hasLiveWakeCoverage(db, companyId, issue.id)) {
    await record("covered");
    return;
  }

  // 2. Call the callback.
  try {
    await input.onOwnerActionCreated({
      mission, issue, sourceIssue: oversightIssue,
      reason: "qa_rework_cap_oversight_created",
    });
  } catch (err) {
    await record("failed");
    throw err;
  }

  // 3. ALWAYS verify authoritative DB outcome — callback return value is irrelevant.
  //    A non-null resolved callback with no agentWakeupRequests/heartbeat row = failure.
  const nowCovered = await hasLiveWakeCoverage(db, companyId, issue.id);
  if (!nowCovered) {
    await record("failed");
    throw new Error("qa-cap-oversight: no live wake coverage after dispatch — callback resolved but no agentWakeupRequests/heartbeat row");
  }

  await record("dispatched");
}
