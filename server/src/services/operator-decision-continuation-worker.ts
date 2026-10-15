import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { operatorDecisionContinuationStore } from "./operator-decision-continuation-store.js";
import { operatorDecisionWriteService } from "./operator-decisions-write.js";

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
    // [T5] 전달 직전 실제 DB 연결 재검사: Quality 연결 결정은 continuationMode=none 계약이므로
    //   이런 행이 보이면 계약 위반이다 — 절대 깨우지 않고 실패 닫힘(유한 재시도 후 종말).
    if (decision.qualityActionId) {
      await store.failDispatch(continuation.id, workerId, now);
      return;
    }
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
    if (["done", "cancelled"].includes(issue.status)) {
      await store.block(continuation.id, workerId, "issue_terminal", now);
      return;
    }
    // [requester delivery] 전달 대상은 카드 생성 시점의 원 요청자다. 요청자 에이전트가 있으면
    //   그 에이전트(행 존재·같은 회사 검증)에게, 사용자 생성 카드는 기존 계약대로 현재 담당자에게,
    //   둘 다 없는 레거시는 임의 대리 전달 없이 차단한다(attention 처리).
    let targetAgentId: string;
    if (decision.requestedByAgentId) {
      const requester = await db.select({ id: agents.id, companyId: agents.companyId })
        .from(agents).where(eq(agents.id, decision.requestedByAgentId))
        .then((rows) => rows[0] ?? null);
      if (!requester || requester.companyId !== continuation.companyId) {
        await store.block(continuation.id, workerId, "requester_unavailable", now);
        return;
      }
      targetAgentId = requester.id;
    } else if (decision.requestedByUserId) {
      if (!issue.assigneeAgentId) {
        await store.block(continuation.id, workerId, "issue_unassigned", now);
        return;
      }
      targetAgentId = issue.assigneeAgentId;
    } else {
      await store.block(continuation.id, workerId, "requester_unavailable", now);
      return;
    }
    const idempotencyKey = continuation.idempotencyKey;
    if (!idempotencyKey || !decision.result || !decision.resolvedByUserId) {
      await store.failDispatch(continuation.id, workerId, now);
      return;
    }
    const targeted = await store.setTarget(continuation.id, workerId, targetAgentId);
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
      await options.wakeup(targetAgentId, wakeupOptions);
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
    // [stale-card sweep 4a] 전달(dispatch) 뒤에서 오래된 pending 카드를 자동 취소한다. 스윕 실패가
    //   continuation 전달에 영향 주지 않도록 try/catch 로 격리하고 반환값(claimed 수)은 그대로 둔다.
    try {
      await operatorDecisionWriteService(db).sweepStalePendingCards(now);
    } catch (error) {
      logger.warn({
        msg: "Operator decision stale-card sweep failed",
        workerId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    return claimed.length;
  }

  return { pollOnce };
}
