import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  operatorDecisionContinuations,
} from "@paperclipai/db";
import type { OperatorDecisionEffectiveStatus } from "@paperclipai/shared/types/operator-decision";

export interface ContinuationStatusInput {
  continuation: typeof operatorDecisionContinuations.$inferSelect;
  // Keep the query contract narrow: heartbeat_runs can be large, but projection only needs status.
  wakeup: Pick<typeof agentWakeupRequests.$inferSelect, "id" | "status" | "runId"> | null;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "status"> | null;
  issue: Pick<typeof issues.$inferSelect, "id" | "status" | "assigneeAgentId"> | null;
  targetAgent: Pick<typeof agents.$inferSelect, "id" | "status"> | null;
  requestedByAgentId?: string | null;
  now: Date;
}

export interface DerivedContinuationStatus {
  effectiveStatus: OperatorDecisionEffectiveStatus;
  errorCode: string | null;
  attention: boolean;
}

const terminalRunMapping: Record<string, [OperatorDecisionEffectiveStatus, string | null, boolean]> = {
  succeeded: ["completed", null, false],
  failed: ["failed", "heartbeat_failed", true],
  // A cancelled/timed-out continuation whose linked issue is terminal has no remaining delivery.
  cancelled: ["cancelled", "heartbeat_cancelled", false],
  timed_out: ["timed_out", "heartbeat_timed_out", false],
};
const terminalRequestMapping: Record<string, [OperatorDecisionEffectiveStatus, string | null, boolean]> = {
  completed: ["completed", null, false],
  failed: ["failed", "heartbeat_failed", true],
  cancelled: ["cancelled", "heartbeat_cancelled", false],
  skipped: ["skipped", "heartbeat_skipped", false],
  timed_out: ["timed_out", "heartbeat_timed_out", false],
};

function derived(tuple: [OperatorDecisionEffectiveStatus, string | null, boolean]): DerivedContinuationStatus {
  return { effectiveStatus: tuple[0], errorCode: tuple[1], attention: tuple[2] };
}

/** Operator-facing hint: what retrying this continuation actually does next. */
export function buildContinuationRetryHint(
  effectiveStatus: OperatorDecisionEffectiveStatus,
  errorCode: string | null,
  issueStatus: string | null,
): string | null {
  if (errorCode === "issue_unassigned") {
    return issueStatus === "in_progress"
      ? "연결 이슈가 진행 중이지만 담당자가 없습니다. 이슈에 담당자를 지정하면 재시도가 깨움으로 이어집니다."
      : "연결 이슈에 담당자가 없습니다. 이슈에 담당자를 지정한 뒤 재시도하세요.";
  }
  if (errorCode === "issue_terminal") {
    return "연결 이슈가 완료/취소로 종결되어 후속 실행이 불가합니다. 새 카드 또는 이슈 재오픈이 필요합니다.";
  }
  if (errorCode === "requester_unavailable") {
    return "카드를 요청한 에이전트(요청자)를 확인할 수 없어 후속 실행이 차단되었습니다. 요청자 에이전트 확인 후 재시도하세요.";
  }
  if (effectiveStatus === "exhausted") {
    return "자동 후속 실행이 시도 한도를 소진했습니다. 재시도는 수동으로 한 번 더 깨웁니다.";
  }
  if (effectiveStatus === "failed" || effectiveStatus === "timed_out") {
    return "후속 실행 런이 실패/시간 초과했습니다. 재시도는 같은 지시로 실행을 다시 깨웁니다.";
  }
  return null;
}

export function deriveOperatorDecisionContinuationStatus(
  input: ContinuationStatusInput,
): DerivedContinuationStatus {
  const result = deriveContinuationStatusInternal(input);
  const { issue } = input;
  // A terminal issue means even a failed/deferred continuation no longer needs operator attention.
  if (result.attention && issue && ["done", "cancelled"].includes(issue.status)) {
    return { effectiveStatus: "skipped", errorCode: "issue_terminal", attention: false };
  }
  return result;
}

function deriveContinuationStatusInternal(input: ContinuationStatusInput): DerivedContinuationStatus {
  const { continuation, wakeup, run, issue, targetAgent, now } = input;
  if (continuation.state === "blocked") {
    if (continuation.errorCode === "issue_unassigned" || continuation.errorCode === "issue_terminal") {
      if (issue && ["done", "cancelled"].includes(issue.status)) {
        return { effectiveStatus: "skipped", errorCode: "issue_terminal", attention: false };
      }
    }
    return { effectiveStatus: "blocked", errorCode: continuation.errorCode, attention: true };
  }
  if (continuation.state === "exhausted") {
    return { effectiveStatus: "exhausted", errorCode: "attempts_exhausted", attention: true };
  }
  if (continuation.state === "pending") {
    if (now.getTime() > continuation.nextAttemptAt.getTime() + 30_000) {
      return { effectiveStatus: "pending", errorCode: "dispatch_delayed", attention: true };
    }
    return {
      effectiveStatus: "pending",
      errorCode: continuation.errorCode === "dispatch_failed" ? "dispatch_failed" : null,
      attention: false,
    };
  }
  if (continuation.state === "leased") {
    const expired = continuation.leaseExpiresAt !== null
      && continuation.leaseExpiresAt.getTime() < now.getTime();
    return { effectiveStatus: "dispatching", errorCode: expired ? "lease_expired" : null, attention: expired };
  }
  if (continuation.state !== "accepted" || !wakeup) {
    return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
  }
  if (run && terminalRunMapping[run.status]) return derived(terminalRunMapping[run.status]!);
  if (terminalRequestMapping[wakeup.status]) return derived(terminalRequestMapping[wakeup.status]!);
  if (wakeup.status === "coalesced" && run && ["queued", "running"].includes(run.status)) {
    return { effectiveStatus: "coalesced", errorCode: null, attention: false };
  }
  if (wakeup.status === "claimed" && run && ["queued", "running"].includes(run.status)) {
    return { effectiveStatus: "running", errorCode: null, attention: false };
  }
  if (["coalesced", "claimed"].includes(wakeup.status)) {
    return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
  }
  if (["queued", "deferred_issue_execution"].includes(wakeup.status)) {
    if (!issue) return { effectiveStatus: "blocked", errorCode: "issue_missing", attention: true };
    const requesterTargeted = Boolean(input.requestedByAgentId);
    if (!requesterTargeted && !issue.assigneeAgentId) {
      return { effectiveStatus: "blocked", errorCode: "issue_unassigned", attention: true };
    }
    if (["done", "cancelled"].includes(issue.status)) {
      return { effectiveStatus: "issue_terminal", errorCode: "issue_terminal", attention: true };
    }
    if (!requesterTargeted && issue.assigneeAgentId !== continuation.targetAgentId) {
      return { effectiveStatus: "assignee_changed", errorCode: "assignee_changed", attention: true };
    }
    if (!targetAgent || ["paused", "terminated", "pending_approval"].includes(targetAgent.status)) {
      return { effectiveStatus: "agent_unrunnable", errorCode: "agent_unrunnable", attention: true };
    }
    return {
      effectiveStatus: wakeup.status === "queued" ? "queued" : "deferred",
      errorCode: null,
      attention: false,
    };
  }
  return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
}
