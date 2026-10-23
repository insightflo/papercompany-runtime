import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * [성긴 deferred 깨움 승격 2026-10-23] deferred_issue_execution 깨움은 "이슈의 실행 런이 해제될 때
 *   승격" 계약으로 삽입되지만, 해제-승격 루프가 실행되지 않는 경로(런이 이슈 execution 을 붙잡은 채
 *   끝나지 않거나, 지연 사유가 사라진 뒤에도 아무도 다시 보지 않는 경우)에 영원히 성김 — 사람의
 *   운영자 결정이 담당 에이전트에 전달되지 못한다(라이브 관측: dsh-purge 재계획 결정 깨움 18h+ 성김,
 *   coalesce 6회). 이 스위퍼는 이슈를 아무도 붙잡지 않고(execution/checkout 없음 + 대상 에이전트의
 *   활성 하트비트 없음) 충분히 오래된(기본 10분) deferred 깨움을 queued 로 승격해 일반 대기열
 *   처리(startNextQueuedRunForAgent)에 돌려보낸다.
 */

const STRANDED_AFTER_MS = 10 * 60 * 1000;

export async function promoteStrandedDeferredWakes(db: Db, now = new Date()): Promise<number> {
  const candidates = await db.select({
    id: agentWakeupRequests.id,
    companyId: agentWakeupRequests.companyId,
    agentId: agentWakeupRequests.agentId,
    issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
    requestedAt: agentWakeupRequests.requestedAt,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(agentWakeupRequests.runId),
    lt(agentWakeupRequests.requestedAt, new Date(now.getTime() - STRANDED_AFTER_MS)),
  )).limit(100);

  let promoted = 0;
  for (const candidate of candidates) {
    try {
      if (!candidate.issueId) continue;
      const [issue] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
        .from(issues).where(eq(issues.id, candidate.issueId)).limit(1);
      // 이슈가 여전히 실행/체크아웃 중이면 계약대로 해제 시 승격 대기한다.
      if (!issue || issue.executionRunId !== null || issue.checkoutRunId !== null) continue;
      // 대상 에이전트가 같은 이슈에서 실행 중이면 승격보류(중복 실행 방지).
      const [activeRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, candidate.agentId),
        eq(heartbeatRuns.issueId, candidate.issueId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      )).limit(1);
      if (activeRun) continue;
      const updated = await db.update(agentWakeupRequests)
        .set({ status: "queued", updatedAt: now }).where(and(
          eq(agentWakeupRequests.id, candidate.id),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        )).returning({ id: agentWakeupRequests.id });
      if (updated.length !== 1) continue;
      promoted += 1;
      await db.insert(activityLog).values({
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system:deferred-wake-promotion",
        action: "wakeup.deferred_promoted",
        entityType: "agent_wakeup_request",
        entityId: candidate.id,
        details: { schemaVersion: 1, wakeupRequestId: candidate.id, issueId: candidate.issueId,
          requestedAt: candidate.requestedAt.toISOString(), promotedAt: now.toISOString() },
      });
    } catch (error) {
      logger.warn({ err: error, wakeupRequestId: candidate.id }, "stranded deferred wake promotion failed");
    }
  }
  return promoted;
}
