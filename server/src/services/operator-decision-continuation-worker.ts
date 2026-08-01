import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { operatorDecisionContinuationStore } from "./operator-decision-continuation-store.js";

interface WakeupOptions {
  source: "automation";
  triggerDetail: "system";
  reason: "operator_decision_resolved";
  payload: {
    kind: "operator_decision_resolution";
    operatorDecisionId: string;
    issueId: string;
    actionId: string;
    selectedOptionIds: string[];
  };
  contextSnapshot: {
    issueId: string;
    wakeReason: "operator_decision_resolved";
    operatorDecisionId: string;
  };
  requestedByActorType: "user";
  requestedByActorId: string;
  idempotencyKey: string;
}

export interface OperatorDecisionHeartbeatAdmission {
  wakeup(agentId: string, options: WakeupOptions): Promise<unknown>;
}

export interface OperatorDecisionWorkerOptions extends OperatorDecisionHeartbeatAdmission {
  workerId?: string;
}

export function operatorDecisionContinuationWorker(db: Db, options: OperatorDecisionWorkerOptions) {
  const workerId = options.workerId ?? `operator-decision-${process.pid}`;
  const store = operatorDecisionContinuationStore(db);

  async function dispatch(continuationId: string, now: Date) {
    const context = await store.getDispatchContext(continuationId);
    if (!context || context.continuation.state !== "leased" || context.continuation.leaseOwner !== workerId) return;
    const { continuation, decision } = context;
    if (!continuation.issueId) {
      await store.block(continuation.id, workerId, "issue_missing", now);
      return;
    }
    const issue = await db.select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(and(
      eq(issues.id, continuation.issueId),
      eq(issues.companyId, continuation.companyId),
    )).then((rows) => rows[0] ?? null);
    if (!issue) {
      await store.block(continuation.id, workerId, "issue_missing", now);
      return;
    }
    if (!issue.assigneeAgentId) {
      await store.block(continuation.id, workerId, "issue_unassigned", now);
      return;
    }
    if (["done", "cancelled"].includes(issue.status)) {
      await store.block(continuation.id, workerId, "issue_terminal", now);
      return;
    }
    const idempotencyKey = continuation.idempotencyKey;
    if (!idempotencyKey || !decision.result || !decision.resolvedByUserId) {
      await store.failDispatch(continuation.id, workerId, now);
      return;
    }
    const targeted = await store.setTarget(continuation.id, workerId, issue.assigneeAgentId);
    if (!targeted) return;
    const wakeupOptions: WakeupOptions = {
      source: "automation",
      triggerDetail: "system",
      reason: "operator_decision_resolved",
      payload: {
        kind: "operator_decision_resolution",
        operatorDecisionId: decision.id,
        issueId: issue.id,
        actionId: decision.result.actionId,
        selectedOptionIds: decision.result.selectedOptionIds,
      },
      contextSnapshot: {
        issueId: issue.id,
        wakeReason: "operator_decision_resolved",
        operatorDecisionId: decision.id,
      },
      requestedByActorType: "user",
      requestedByActorId: decision.resolvedByUserId,
      idempotencyKey,
    };
    try {
      await options.wakeup(issue.assigneeAgentId, wakeupOptions);
    } catch {
      // Durable proof, not the call result, determines acceptance.
    } finally {
      const proof = await store.findProof(continuation.companyId, idempotencyKey);
      if (proof) {
        await store.accept(continuation.id, workerId, proof.agentId, proof.id, now);
      } else {
        await store.failDispatch(continuation.id, workerId, now);
      }
    }
  }

  async function pollOnce(now = new Date()) {
    const claimed = await store.claimBatch(workerId, now);
    for (const continuation of claimed) await dispatch(continuation.id, now);
    return claimed.length;
  }

  return { pollOnce };
}
