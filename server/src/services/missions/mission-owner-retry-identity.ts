import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { buildMissionOwnerDecisionWakeupIdempotencyKey } from "./mission-owner-recovery-events.js";
import type { MissionOwnerDecisionRecord } from "./mission-owner-recovery-ledger.js";

// Session lock is held on a reserved connection, not the callback's transaction:
// native resume uses its own DB connection and must see committed apply records.
export async function acquireOwnerRetryLock(db: Db, companyId: string, ownerIssueId: string): Promise<(() => Promise<void>) | null> {
  const client = await db.$client.reserve();
  const key = `mission-owner-retry:${companyId}:${ownerIssueId}`;
  try {
    const [row] = await client`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`;
    if (!row?.acquired) { client.release(); return null; }
  } catch (error) { client.release(); throw error; }
  return async () => {
    try { await client`select pg_advisory_unlock(hashtextextended(${key}, 0))`; }
    finally { client.release(); }
  };
}

export async function resolveOwnerRetryKey(input: {
  db: Db; companyId: string; missionId: string; ownerActionIssueId: string; sourceIssueId: string;
  decision: MissionOwnerDecisionRecord | null;
}): Promise<string> {
  const identity = { missionId: input.missionId, ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.sourceIssueId };
  const legacyKey = buildMissionOwnerDecisionWakeupIdempotencyKey(identity);
  if (!input.decision) return legacyKey; // Existing automatic policy keeps its lifetime key.
  const [events, wakes] = await Promise.all([
    input.db.select({ at: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      inArray(workflowTransitionEvents.idempotencyKey, [legacyKey, `${legacyKey}:apply`]),
    )),
    input.db.select({ at: agentWakeupRequests.requestedAt }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, legacyKey),
    )),
  ]);
  // Historical rows have no event binding. Never re-arm decisions at/before their
  // recorded execution boundary. No rows are rewritten and no decision is invented.
  if ([...events, ...wakes].some(row => row.at >= input.decision!.createdAt)) return legacyKey;
  return buildMissionOwnerDecisionWakeupIdempotencyKey({ ...identity, decisionEventId: input.decision.eventId });
}
