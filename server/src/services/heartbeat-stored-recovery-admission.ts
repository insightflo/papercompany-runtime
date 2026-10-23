import { and, asc, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, issues, withTxTimeout, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { assertHeartbeatRecoveryAdmission } from "./heartbeat-recovery-guard.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "./operator-decision-continuation-store.js";
import { promoteDeferredWakeupRequest, type HeartbeatFollowupPromotionDeps } from "./heartbeat-followup-promotion.js";
import { isQaCorrectionWakeKey } from "./quality/native-wake.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Wake = typeof agentWakeupRequests.$inferSelect;

function pending(error: unknown) {
  return error instanceof Error && error.message === "operator_decision_delivery_pending_acceptance";
}

/** Preserve authority/continuation -> wake lock order, then revalidate the locked stored row. */
export async function lockStoredRecoveryAdmission(tx: Tx, observed: Wake, contextKey: string) {
  const validate = (wake: Wake) => assertHeartbeatRecoveryAdmission(tx as unknown as Db, {
    ...wake, wakeupRequestId: wake.id, contextSnapshot: parseObject(wake.payload)[contextKey],
    operatorDecisionStoredAdmission: true,
  });
  try { await validate(observed); } catch (error) { if (pending(error)) return null; throw error; }
  const [locked] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, observed.id), eq(agentWakeupRequests.companyId, observed.companyId),
  )).for("update");
  if (!locked) return null;
  try { await validate(locked); } catch (error) { if (pending(error)) return null; throw error; }
  return locked;
}

export function isStoredOperatorDecisionWake(wake: Pick<Wake, "idempotencyKey" | "payload">, contextKey: string) {
  const payload = parseObject(wake.payload), context = parseObject(payload[contextKey]);
  return wake.idempotencyKey?.startsWith(OPERATOR_DECISION_WAKE_PREFIX) === true
    || payload.kind === "operator_decision_resolution" || context.wakeReason === "operator_decision_resolved";
}

/** Promote accepted C08 deferred rows in a fresh root transaction; stale rows cannot roll back issue release. */
export async function promoteStoredDeferredWakes(db: Db, deps: HeartbeatFollowupPromotionDeps,
  agent: typeof agents.$inferSelect, limit: number,
  isWorkflowStepResumeWake: (input: { requestKind?: unknown; reason?: unknown; payload?: unknown; contextSnapshot?: unknown }) => boolean) {
  if (limit <= 0) return [];
  const contextKey = deps.deferredWakeContextKey;
  const candidates = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agent.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.runId} is null`,
  )).orderBy(asc(agentWakeupRequests.requestedAt)).limit(Math.max(limit * 4, limit));
  const promoted: Array<Awaited<ReturnType<typeof promoteDeferredWakeupRequest>>> = [];
  for (const candidate of candidates) {
    if (promoted.length >= limit) break;
    const run = await withTxTimeout(db, async tx => {
      const [observed] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, candidate.id), eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.runId} is null`));
      if (!observed) return null;
      if (isQaCorrectionWakeKey(observed.idempotencyKey)
        || Object.hasOwn(parseObject(observed.payload), "qaCorrectionFollowup")) return null;
      const ownerDecision = isStoredOperatorDecisionWake(observed, contextKey);
      let lockedIssue: typeof issues.$inferSelect | null = null;
      let wake: Wake | null;
      try {
        if (ownerDecision)
          wake = await lockStoredRecoveryAdmission(tx, observed, contextKey);
        else {
          if (!observed.issueId) return null;
          [lockedIssue] = await tx.select().from(issues).where(and(eq(issues.id, observed.issueId),
            eq(issues.companyId, observed.companyId))).for("update");
          [wake] = await tx.select().from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.id, observed.id), eq(agentWakeupRequests.companyId, observed.companyId),
            eq(agentWakeupRequests.agentId, agent.id))).for("update");
        }
      }
      catch (error) {
        await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(),
          error: error instanceof Error ? error.message : "Recovery admission refused", updatedAt: new Date(),
        }).where(and(eq(agentWakeupRequests.id, observed.id),
          eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.runId} is null`));
        return null;
      }
      if (!wake?.issueId || wake.companyId !== agent.companyId || wake.agentId !== agent.id
        || wake.status !== "deferred_issue_execution" || wake.runId !== null) return null;
      const issue = ownerDecision ? await tx.select().from(issues).where(and(eq(issues.id, wake.issueId),
        eq(issues.companyId, wake.companyId))).for("update").then(rows => rows[0] ?? null) : lockedIssue;
      if (issue?.id !== wake.issueId) return null;
      if (!issue || issue.executionRunId || issue.checkoutRunId) return null;
      const payload = parseObject(wake.payload), contextSnapshot = parseObject(payload[contextKey]);
      const allowDone = isWorkflowStepResumeWake({ requestKind: wake.requestKind, reason: wake.reason,
        payload, contextSnapshot }) || (wake.reason === "mission_owner_plan_rework_requested"
        && issue.originKind === "mission_main_executor_plan");
      if (!deps.issueRunStartStatuses.includes(issue.status) && !(allowDone && issue.status === "done")) {
        await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(),
          error: `Deferred wake rejected: issue terminal (status=${issue.status})`, updatedAt: new Date(),
        }).where(eq(agentWakeupRequests.id, wake.id));
        return null;
      }
      return promoteDeferredWakeupRequest(deps, tx, { deferred: wake, deferredAgent: agent, issue });
    });
    if (run) promoted.push(run);
  }
  return promoted;
}
