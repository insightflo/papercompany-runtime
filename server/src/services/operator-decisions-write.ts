import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, missions, operatorDecisions } from "@paperclipai/db";
import { operatorDecisionOutcomeInputSchema } from "@paperclipai/shared/validators/operator-decision";
import { conflict, forbidden, notFound } from "../errors.js";
import { guardQualityWrite } from "./quality/write-guard.js";
import { operatorDecisionContinuationRetryService } from "./operator-decision-continuation-retry.js";
import { operatorDecisionReadService } from "./operator-decisions-read.js";
import {
  operatorDecisionCreateService,
  type OperatorDecisionActor,
} from "./operator-decision-create.js";
import { operatorDecisionResolutionWriteService } from "./operator-decision-resolution-write.js";
import {
  collectTargetSnapshotMismatch,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  readTargetSnapshot,
} from "./operator-decision-currentness.js";

export type { OperatorDecisionActor } from "./operator-decision-create.js";
export type { IssueStatusCurrentnessPolicy } from "./operator-decision-currentness.js";

// [stale-card sweep 4a] 시스템 스윕 주체 식별자 — activity 감사(activityLog.actorId)와 카드 취소
//   세부(details.cancelledByActorId) 양쪽에 같은 값을 쓴다. 사람 취소·요청자 취소와 감사 구조를 공유한다.
const STALE_SWEEP_ACTOR_ID = "system:operator-decision-stale-sweep";
// [stale-card sweep 4a] 한 번의 pollOnce 스윕이 검사하는 후보 상한 — 대량 테이블 스캔·장기 점유 방지.
const STALE_SWEEP_BATCH_LIMIT = 50;

function conflictFor(id: string, status: string, message = "Operator decision conflict") {
  return conflict(message, { operatorDecisionId: id, status });
}

export function operatorDecisionWriteService(db: Db) {
  const read = operatorDecisionReadService(db);
  const retry = operatorDecisionContinuationRetryService(db);
  const { create } = operatorDecisionCreateService(db, { read, conflictFor });
  const { resolve } = operatorDecisionResolutionWriteService(db, { read, conflictFor });

  async function cancel(id: string, actor: OperatorDecisionActor, reason?: string) {
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    if (actor.type === "agent" && before.requestedByAgentId !== actor.id) throw forbidden("Only the requester can cancel this decision");
    // [T5] Quality 연결 결정의 취소도 전용 경로로(sourceType 아닌 실제 연결 기준).
    await guardQualityWrite(db, { companyId: before.companyId, subject: "decision", subjectId: id, operation: "cancel" });
    if (before.status === "cancelled") return { decision: await read.getRequired(id), applied: false };
    if (before.status !== "pending") throw conflictFor(id, before.status);
    await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.update(operatorDecisions).set({ status: "cancelled", cancelledAt: now, updatedAt: now })
        .where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning({ id: operatorDecisions.id });
      if (updated.length !== 1) throw conflictFor(id, "terminal");
      await tx.insert(activityLog).values({
        companyId: before.companyId,
        actorType: actor.type,
        actorId: actor.id,
        agentId: actor.type === "agent" ? actor.id : null,
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          cancelledByActorType: actor.type,
          cancelledByActorId: actor.id,
          cancelledAt: now.toISOString(),
          ...(reason ? { reason } : {}),
        },
      });
    });
    return { decision: await read.getRequired(id), applied: true };
  }

  // [4c outcome] 요청자 에이전트의 결과 회신 — resolved 카드에 대해 원 요청자만 status 를 구조화돼
  //   되돌린다. 카드 행·continuation 은 불변이고 회신은 activity 투영만 남긴다(append-only:
  //   in_progress 갱신·최종 상태 뒤 재보고까지 차단 없이 모두 기록). 보드 사용자·다른 에이전트의
  //   대리 보고는 금지(403) — 권위 값은 status(enum)뿐이고 reason/detail 은 표시용이다.
  async function reportOutcome(id: string, actor: OperatorDecisionActor, rawInput: unknown, now = new Date()) {
    const input = operatorDecisionOutcomeInputSchema.parse(rawInput);
    if (actor.type !== "agent") throw forbidden("Only the card requester agent may report the outcome");
    // 회사 스코프 로드 — 요청자 에이전트가 속한 회사의 카드만 보인다(다른 회사·알 수 없는 에이전트는 404).
    const agent = await db.select({ companyId: agents.companyId }).from(agents)
      .where(eq(agents.id, actor.id)).then((rows) => rows[0] ?? null);
    const row = agent
      ? await db.select().from(operatorDecisions).where(and(
          eq(operatorDecisions.id, id),
          eq(operatorDecisions.companyId, agent.companyId),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (!row) throw notFound("Operator decision not found");
    if (actor.id !== row.requestedByAgentId) throw forbidden("Only the card requester agent may report the outcome");
    if (row.status !== "resolved") throw conflictFor(id, row.status, "Operator decision outcome requires a resolved card");
    await db.insert(activityLog).values({
      companyId: row.companyId,
      actorType: "agent",
      actorId: actor.id,
      agentId: actor.id,
      action: "operator_decision.outcome_reported",
      entityType: "operator_decision",
      entityId: id,
      details: {
        schemaVersion: 1,
        operatorDecisionId: id,
        requesterAgentId: actor.id,
        status: input.status,
        ...(input.reason != null ? { reason: input.reason } : {}),
        ...(input.detail != null ? { detail: input.detail } : {}),
        reportedAt: now.toISOString(),
      },
    });
    return { applied: true, decision: await read.getRequired(id) };
  }

  // [stale-card sweep 4a] 선택 전 상태 변경 → 카드 자동 취소(2026-10-15 정책). 스냅샷 있는 pending 카드 중
  //   현재 상태와 불일치하는 카드를 시스템 주체로 cancelled 처리한다. 불일치 판정은 2단계
  //   assertTargetSnapshotCurrent(409 target_changed)와 같은 비교(collectTargetSnapshotMismatch)를
  //   재사용하고, 취소는 pending CAS 로만
  //   적용해 동시 resolve 승리 시 조용히 건너뛴다. 취소는 continuation/wakeup 을 만들지 않는다.
  //   Quality 연결 카드(qualityActionId)는 T5 전용 경로 계약대로 후보에서 제외한다.
  // [moi terminal-anchor sweep 2026-10-17] mission_owner_human_input pending 카드는 완화 기준으로만
  //   취소한다 — 앵커 이슈 종결(done/cancelled)·소멸, 스냅샷 식별자 소멸, 또는 미션 cancelled.
  //   열린 상태 간 이슈 status churn 으로는 사람 결정 요청을 취소하지 않는다(사람이 볼 새 없이 승인
  //   버튼이 사라진 2026-10-17 라이브 사고 재발 방지). 미션 completed 는 앵커 이슈 종결로 이미
  //   커버되므로 취소 트리거에 넣지 않는다(미션명·이슈명 같은 예시 특수 로직 없음).
  async function sweepStalePendingCards(now = new Date()) {
    const candidates = await db.select({
      id: operatorDecisions.id,
      companyId: operatorDecisions.companyId,
      sourceType: operatorDecisions.sourceType,
      sourceContext: operatorDecisions.sourceContext,
    }).from(operatorDecisions).where(and(
      eq(operatorDecisions.status, "pending"),
      isNull(operatorDecisions.qualityActionId),
      sql`coalesce(${operatorDecisions.sourceContext}, '{}'::jsonb) ? 'targetSnapshot'`,
    )).limit(STALE_SWEEP_BATCH_LIMIT);

    let checked = 0;
    let cancelled = 0;
    for (const candidate of candidates) {
      const snapshot = readTargetSnapshot(candidate.sourceContext);
      // 재검증 식별자(issueId/workflowRunId/stepRunId) 없는 스냅샷은 판정 불가 — 쓰지 않고 건너뛴다.
      if (!snapshot || (snapshot.issueId == null && snapshot.workflowRunId == null && snapshot.stepRunId == null)) continue;
      checked += 1;
      const moi = candidate.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE;
      const mismatch = await collectTargetSnapshotMismatch(db, candidate.companyId, snapshot,
        moi ? "terminal_only" : "exact");
      if (moi && mismatch.length === 0) {
        // [moi] 미션 cancelled 판정 — missionId 는 moi 카드 생성 시 항상 채워진다(빠면 판정 불가로 통과).
        const sourceContext = candidate.sourceContext as unknown as Record<string, unknown> | null;
        const missionId = typeof sourceContext?.missionId === "string" ? sourceContext.missionId : null;
        if (missionId) {
          const mission = await db.select({ companyId: missions.companyId, status: missions.status }).from(missions)
            .where(eq(missions.id, missionId)).then((rows) => rows[0] ?? null);
          if (mission?.companyId === candidate.companyId && mission.status === "cancelled") mismatch.push("missionStatus");
        }
      }
      if (mismatch.length === 0) continue; // 여전히 일치 — 아무 것도 쓰지 않는다.
      const cancelledNow = await db.transaction(async (tx) => {
        const updated = await tx.update(operatorDecisions).set({
          status: "cancelled", cancelledAt: now, updatedAt: now,
        }).where(and(eq(operatorDecisions.id, candidate.id), eq(operatorDecisions.status, "pending")))
          .returning({ id: operatorDecisions.id });
        if (updated.length !== 1) return false; // 동시 resolve/cancel 승리 — 조용히 skip
        await tx.insert(activityLog).values({
          companyId: candidate.companyId,
          actorType: "user",
          actorId: STALE_SWEEP_ACTOR_ID,
          agentId: null,
          action: "operator_decision.cancelled",
          entityType: "operator_decision",
          entityId: candidate.id,
          details: {
            schemaVersion: 1,
            operatorDecisionId: candidate.id,
            cancelledByActorType: "user",
            cancelledByActorId: STALE_SWEEP_ACTOR_ID,
            cancelledAt: now.toISOString(),
            reason: "target_changed",
            mismatch,
          },
        });
        return true;
      });
      if (cancelledNow) cancelled += 1;
    }
    return { checked, cancelled };
  }

  return { create, resolve, cancel, reportOutcome, retryContinuation: retry.retryContinuation, sweepStalePendingCards };
}
