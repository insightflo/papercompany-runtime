import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import type {
  OperatorDecisionContinuationView,
  OperatorDecisionEffectiveStatus,
  OperatorDecisionRequesterOutcomeView,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";

export interface ContinuationStatusInput {
  continuation: typeof operatorDecisionContinuations.$inferSelect;
  // [열 좁히기 2026-10-20] 파생은 status/runId 만 읽는다. heartbeat_runs 는 행당 수백 KB TOAST 라
  //   전체 행 로드가 목록 병목(90행 = 1.1s)이었으므로 최소 필드만 요청한다. 전체 행도 구조적으로 만족한다.
  wakeup: Pick<typeof agentWakeupRequests.$inferSelect, "id" | "status" | "runId"> | null;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "status"> | null;
  issue: Pick<typeof issues.$inferSelect, "id" | "status" | "assigneeAgentId"> | null;
  targetAgent: Pick<typeof agents.$inferSelect, "id" | "status"> | null;
  /** 카드 원 요청자 에이전트 — 있으면 전달 대상이 요청자로 고정된 카드다. */
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
  // [terminal cleanup] a cancelled/timed-out continuation run whose linked issue is
  // done/cancelled has no remaining delivery — the mission moved past it (mission cancel
  // cascades run terminalization). Non-attention, same as 8/25 morning GAZ-1315 rows.
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

/** Operator-facing Korean hint: what retrying this continuation actually does next. */
function buildContinuationRetryHint(
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
  // [terminal cleanup 2026-10-04] 연결 이슈가 완료/취소로 종결된 continuation 은 어떤
  //   상태(failed/deferred/unassigned/exhausted/…)도 운영자 행동 대상이 아니다 — 미션은
  //   이미 지나갔다(attention 뷰에는 지우기 수단이 없어 카드가 영구히 남는다).
  //   성공 전달(completed, 원래 비-attention)은 그대로 둔다. blocked 상태에 대한 기존
  //   GAZ-1315 정리와 같은 원칙을 전 상태로 확장한다.
  if (result.attention && issue && ["done", "cancelled"].includes(issue.status)) {
    return { effectiveStatus: "skipped", errorCode: "issue_terminal", attention: false };
  }
  return result;
}

function deriveContinuationStatusInternal(
  input: ContinuationStatusInput,
): DerivedContinuationStatus {
  const { continuation, wakeup, run, issue, targetAgent, now } = input;
  if (continuation.state === "blocked") {
    // [terminal cleanup] A blocked continuation whose linked issue has since reached a
    // terminal state (done/cancelled) no longer represents actionable operator work —
    // the mission moved on (e.g. oversight issue completed after a workflow finished).
    // Classify as skipped (non-attention) instead of leaving a stale retry card up.
    if (
      continuation.errorCode === "issue_unassigned" || continuation.errorCode === "issue_terminal"
    ) {
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
    const expired = continuation.leaseExpiresAt !== null && continuation.leaseExpiresAt.getTime() < now.getTime();
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
    // [requester delivery] 요청자 전달 카드는 대상이 요청자로 고정된다 — 담당자 유무/변경은
    //   전달 유효성과 무관하므로 issue_unassigned/assignee_changed 오경보를 내지 않는다.
    //   요청자 불능은 targetAgent paused/terminated/pending_approval 검사가 담당한다.
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

type OperatorDecisionRow = typeof operatorDecisions.$inferSelect;
type OperatorDecisionProjection = {
  view: OperatorDecisionView;
  attention: boolean;
  continuationUpdatedAt: Date | null;
};

function uniqueIds(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

// [N+1 제거 2026-10-20] 페이지 단위 일괄 투영 — 목록(list)이 카드마다 최대 ~8쿼리를 돌려
//   회사 카드 286행 시대에 호출당 2.5s+ 걸리던 근원. 테이블별 inArray 1쿼리로 동일 투영을
//   만든다. 판정 순서·필드는 기존 행별 경로와 동일하게 유지한다(의미 변경 없음).
export async function loadOperatorDecisionProjections(
  db: Db,
  rows: readonly OperatorDecisionRow[],
  now = new Date(),
): Promise<OperatorDecisionProjection[]> {
  if (rows.length === 0) return [];

  const decisionIds = rows.map((row) => row.id);
  const continuations = await db.select().from(operatorDecisionContinuations)
    .where(inArray(operatorDecisionContinuations.operatorDecisionId, decisionIds));
  const continuationByDecisionId = new Map(continuations.map((row) => [row.operatorDecisionId, row]));

  const wakeupIds = uniqueIds(continuations.map((row) => row.wakeupRequestId));
  const wakeups = wakeupIds.length > 0
    ? await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeupIds))
    : [];
  const wakeupById = new Map(wakeups.map((row) => [row.id, row]));

  const runIds = uniqueIds(wakeups.map((row) => row.runId));
  // heartbeat_runs 전체 행은 행당 수백 KB(라이브 테이블 7GB TOAST) — status 만 읽으므로 최소 컬럼만.
  const runs = runIds.length > 0
    ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds))
    : [];
  const runById = new Map(runs.map((row) => [row.id, row]));

  // 이슈는 카드 직접 링크(row.issueId)와 continuation 링크 양쪽에서 필요하다 — 한 번에 조회한다.
  const issueIds = uniqueIds([
    ...rows.map((row) => row.issueId),
    ...continuations.map((row) => row.issueId),
  ]);
  const issueRows = issueIds.length > 0
    ? await db.select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      identifier: issues.identifier,
      title: issues.title,
      missionId: issues.missionId,
    }).from(issues).where(inArray(issues.id, issueIds))
    : [];
  const issueById = new Map(issueRows.map((row) => [row.id, row]));

  const missionIds = uniqueIds(issueRows.map((row) => row.missionId));
  const missionRows = missionIds.length > 0
    ? await db.select({ id: missions.id, title: missions.title }).from(missions)
      .where(inArray(missions.id, missionIds))
    : [];
  const missionById = new Map(missionRows.map((row) => [row.id, row]));

  const agentIds = uniqueIds(continuations.map((row) => row.targetAgentId));
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, status: agents.status }).from(agents)
      .where(inArray(agents.id, agentIds))
    : [];
  const agentById = new Map(agentRows.map((row) => [row.id, row]));

  // [4b-1 투영] 카드 상태별 activity 최신 1건으로 요청자 outcome·취소 사유를 만든다.
  //   resolved → 최신 outcome_reported, cancelled → 최신 cancelled 의 reason,
  //   pending → 조회하지 않고 모두 null. 두 action을 한 번에 가져와 최신만 쓴다.
  const outcomeSourceIds = rows.filter((row) => row.status !== "pending").map((row) => row.id);
  const outcomeRows = outcomeSourceIds.length > 0
    ? await db.select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    }).from(activityLog).where(and(
      eq(activityLog.entityType, "operator_decision"),
      inArray(activityLog.entityId, outcomeSourceIds),
      inArray(activityLog.action, ["operator_decision.outcome_reported", "operator_decision.cancelled"]),
    ))
    : [];
  const latestOutcomeByKey = new Map<string, (typeof outcomeRows)[number]>();
  for (const outcomeRow of outcomeRows) {
    const key = `${outcomeRow.entityId}|${outcomeRow.action}`;
    const existing = latestOutcomeByKey.get(key);
    if (!existing || outcomeRow.createdAt.getTime() > existing.createdAt.getTime()) {
      latestOutcomeByKey.set(key, outcomeRow);
    }
  }

  return rows.map((row) => {
    const continuation = continuationByDecisionId.get(row.id) ?? null;
    const wakeup = continuation?.wakeupRequestId ? wakeupById.get(continuation.wakeupRequestId) ?? null : null;
    const run = wakeup?.runId ? runById.get(wakeup.runId) ?? null : null;
    const continuationIssue = continuation?.issueId ? issueById.get(continuation.issueId) ?? null : null;
    const continuationMission = continuationIssue?.missionId
      ? missionById.get(continuationIssue.missionId) ?? null
      : null;
    const targetAgent = continuation?.targetAgentId ? agentById.get(continuation.targetAgentId) ?? null : null;
    // [requester delivery] 요청자 전달 카드 판별용 — continuation 은 원 요청자를 모른다.
    //   행에 이미 있으므로 재조회하지 않는다(예전 행별 경로의 중복 쿼리 제거).
    const status = continuation
      ? deriveOperatorDecisionContinuationStatus({
        continuation,
        wakeup,
        run,
        issue: continuationIssue,
        targetAgent,
        requestedByAgentId: row.requestedByAgentId,
        now,
      })
      : null;

    // [display-only] 카드 상단 노출용 링크된 이슈/미션 이름표(rule 8: 표시 전용).
    const linkedIssue = row.issueId ? issueById.get(row.issueId) ?? null : null;
    const linkedMission = linkedIssue?.missionId ? missionById.get(linkedIssue.missionId) ?? null : null;
    const requestedBy = row.requestedByAgentId
      ? { type: "agent" as const, id: row.requestedByAgentId }
      : row.requestedByUserId
        ? { type: "user" as const, id: row.requestedByUserId }
        : null;

    let requesterOutcome: OperatorDecisionRequesterOutcomeView | null = null;
    let cancellationReason: string | null = null;
    if (row.status === "cancelled") {
      const details = latestOutcomeByKey.get(`${row.id}|operator_decision.cancelled`)?.details;
      cancellationReason = typeof details?.reason === "string" ? details.reason : null;
    } else if (row.status === "resolved") {
      const details = latestOutcomeByKey.get(`${row.id}|operator_decision.outcome_reported`)?.details;
      if (details && typeof details.status === "string" && typeof details.reportedAt === "string") {
        requesterOutcome = {
          status: details.status as OperatorDecisionRequesterOutcomeView["status"],
          reason: typeof details.reason === "string" ? details.reason : null,
          detail: typeof details.detail === "string" ? details.detail : null,
          reportedAt: details.reportedAt,
        };
      }
    }

    return {
      view: {
        id: row.id,
        companyId: row.companyId,
        schemaVersion: 1,
        requestKey: row.requestKey,
        status: row.status as OperatorDecisionView["status"],
        priority: row.priority as OperatorDecisionView["priority"],
        interactionType: row.interactionType as OperatorDecisionView["interactionType"],
        title: row.title,
        description: row.description,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceContext: row.sourceContext,
        definition: row.definition,
        result: row.result,
        issueId: row.issueId,
        issueIdentifier: linkedIssue?.identifier ?? null,
        issueTitle: linkedIssue?.title ?? null,
        missionTitle: linkedMission?.title ?? null,
        continuationMode: row.continuationMode as OperatorDecisionView["continuationMode"],
        requestedBy,
        resolvedByUserId: row.resolvedByUserId,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        requesterOutcome,
        cancellationReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        continuation: continuation && status
          ? {
            id: continuation.id,
            state: continuation.state as OperatorDecisionContinuationView["state"],
            generation: continuation.generation,
            attemptCount: continuation.attemptCount,
            maxAttempts: continuation.maxAttempts,
            manualRetryCount: continuation.manualRetryCount,
            maxManualRetries: 2,
            nextAttemptAt: continuation.nextAttemptAt.toISOString(),
            leaseExpiresAt: continuation.leaseExpiresAt?.toISOString() ?? null,
            targetAgentId: continuation.targetAgentId,
            wakeupRequestId: continuation.wakeupRequestId,
            effectiveStatus: status.effectiveStatus,
            errorCode: status.errorCode,
            issueIdentifier: continuationIssue?.identifier ?? null,
            issueTitle: continuationIssue?.title ?? null,
            issueStatus: continuationIssue?.status ?? null,
            issueAssigneeAgentId: continuationIssue?.assigneeAgentId ?? null,
            missionId: continuationMission?.id ?? null,
            missionTitle: continuationMission?.title ?? null,
            retryHint: buildContinuationRetryHint(status.effectiveStatus, status.errorCode, continuationIssue?.status ?? null),
          }
          : null,
      },
      attention: status?.attention ?? false,
      continuationUpdatedAt: continuation?.updatedAt ?? null,
    };
  });
}

export async function loadOperatorDecisionProjection(
  db: Db,
  row: OperatorDecisionRow,
  now = new Date(),
): Promise<OperatorDecisionProjection> {
  const [projection] = await loadOperatorDecisionProjections(db, [row], now);
  if (!projection) throw new Error(`operator decision projection missing for ${row.id}`);
  return projection;
}
