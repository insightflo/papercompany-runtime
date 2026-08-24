import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { operatorDecisionContinuationStore } from "./operator-decision-continuation-store.js";

// [delivery bridge] fresh-run 전달용 해결 요약. definition.options × selectedOptionIds 를
//   한국어 라벨+영어 식별자로 해석해 wake payload 와 contextSnapshot 양쪽에 탑재한다.
//   heartbeat.enrichWakeContextSnapshot 은 issueId 등 화이트리스트 키만 payload→contextSnapshot
//   으로 복사하므로, worker 가 contextSnapshot 에 직접 넣는 것이 확실하다.
interface OperatorDecisionResolutionSummary {
  operatorDecisionId: string;
  options: { id: string; label: string; description: string | null }[];
}

function buildOperatorDecisionResolutionSummary(
  decision: { id: string; definition: { options: { id: string; label: string; description: string | null }[] }; result: { selectedOptionIds: string[] } | null },
): OperatorDecisionResolutionSummary {
  const selected = decision.result?.selectedOptionIds ?? [];
  const byId = new Map(decision.definition.options.map((option) => [option.id, option]));
  return {
    operatorDecisionId: decision.id,
    options: selected.map((optionId) => {
      const option = byId.get(optionId);
      return option
        ? { id: option.id, label: option.label, description: option.description }
        : { id: optionId, label: optionId, description: null };
    }),
  };
}

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
    paperclipOperatorDecisionResolution: OperatorDecisionResolutionSummary;
  };
  contextSnapshot: {
    issueId: string;
    wakeReason: "operator_decision_resolved";
    operatorDecisionId: string;
    paperclipOperatorDecisionResolution: OperatorDecisionResolutionSummary;
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
    const resolutionSummary = buildOperatorDecisionResolutionSummary(decision);
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
        paperclipOperatorDecisionResolution: resolutionSummary,
      },
      contextSnapshot: {
        issueId: issue.id,
        wakeReason: "operator_decision_resolved",
        operatorDecisionId: decision.id,
        paperclipOperatorDecisionResolution: resolutionSummary,
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
