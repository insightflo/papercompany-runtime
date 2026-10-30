import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import type {
  OperatorDecisionContinuationView,
  OperatorDecisionDefinition,
  OperatorDecisionRequesterOutcomeView,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";
import {
  evaluateRecoveryAdvice,
  loadRecoveryAdviceFacts,
  overlayRecoveryAdvice,
} from "./operator-decision-recovery-advice.js";
import { loadQaRecoveryAdviceFacts, overlayQaRecoveryAdvice } from "./operator-decision-qa-recovery-advice.js";
import { normalizeSystemLanguage } from "./missions/system-language.js";
import {
  buildContinuationRetryHint,
  deriveOperatorDecisionContinuationStatus,
  type ContinuationStatusInput,
  type DerivedContinuationStatus,
} from "./operator-decision-continuation-status.js";

export {
  deriveOperatorDecisionContinuationStatus,
  type ContinuationStatusInput,
  type DerivedContinuationStatus,
} from "./operator-decision-continuation-status.js";

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
  const adviceFactsByDecisionId = await loadRecoveryAdviceFacts(db, rows);
  const qaAdviceFactsByDecisionId = await loadQaRecoveryAdviceFacts(db, rows);
  const companyIds = uniqueIds(rows.map((row) => row.companyId));
  const companyLanguages = await db.select({ id: companies.id, defaultLanguage: companies.defaultLanguage })
    .from(companies).where(inArray(companies.id, companyIds));
  const languageByCompanyId = new Map(companyLanguages.map((row) => [row.id, normalizeSystemLanguage(row.defaultLanguage)]));

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

    const adviceFacts = adviceFactsByDecisionId.get(row.id);
    const advice = adviceFacts ? evaluateRecoveryAdvice({ card: row, ...adviceFacts }) : null;
    const qaAdviceFacts = qaAdviceFactsByDecisionId.get(row.id);
    const qaProjection = qaAdviceFacts
      ? overlayQaRecoveryAdvice(row, qaAdviceFacts, languageByCompanyId.get(row.companyId) ?? "en")
      : null;
    const projectedDefinition = advice
      ? overlayRecoveryAdvice(row.definition as OperatorDecisionDefinition, advice)
      : qaProjection?.definition ?? row.definition;

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
        title: qaProjection?.title ?? row.title,
        description: qaProjection?.description ?? row.description,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceContext: row.sourceContext,
        definition: projectedDefinition,
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
