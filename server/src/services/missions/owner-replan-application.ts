import { issues, missionPlanArtifacts, missionPlanDecisionSubmissions, missions, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm";
import { createIssueRecord } from "../issue-create-records.js";
import type { MissionRow } from "../missions.js";
import { listCompanyExecutionCandidates, formatCandidateRosterLines } from "./mission-execution-candidates.js";
import { buildRevisionMissionPlanningDescription } from "./mission-revision-planning.js";
import { missionPlanTemplateService } from "./mission-plan-templates.js";
import { loadLatestMissionOwnerDecision, MISSION_OWNER_RECOVERY_LAYER } from "./mission-owner-recovery-ledger.js";

const RUNNABLE_PLAN_STATUSES = ["backlog", "todo", "in_progress", "in_review"];

// [결정 소모 마커] 하나의 replan_mission 결정(eventId)이 [PLAN] 실체화에 기여한 사실을
// workflow_transition_events 에 영속 기록한다. 종결(done)된 [Owner Action] 카드도 미션이 끝나기
// 전까지 매 감시 스윕의 missionIssues 에 남아 과거 결정이 계속 latest 로 조회되므로, 마커와 충족
// 증거 없이는 [PLAN] 이 done 으로 닫힌 직후부터 매 스윕 새 [PLAN] 이 반복 생성된다(RES-10929).
export const MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE = "mission_owner_replan_applied";

export function buildOwnerReplanAppliedIdempotencyKey(missionId: string, decisionEventId: string): string {
  return `mission-owner-replan-applied:${missionId}:${decisionEventId}`;
}

export type OwnerReplanApplication = {
  planningIssue: typeof issues.$inferSelect;
  resultStatus: "created" | "reused";
};

function markerPlanningIssueId(marker: typeof workflowTransitionEvents.$inferSelect): string | null {
  const value = marker.payload?.planningIssueId;
  return typeof value === "string" ? value : null;
}

async function findAppliedReplanMarker(
  db: Db,
  input: { companyId: string; missionId: string; decisionEventId: string },
): Promise<typeof workflowTransitionEvents.$inferSelect | null> {
  const [marker] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.companyId),
    eq(workflowTransitionEvents.idempotencyKey, buildOwnerReplanAppliedIdempotencyKey(input.missionId, input.decisionEventId)),
    eq(workflowTransitionEvents.eventType, MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE),
    eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
  )).limit(1);
  return marker ?? null;
}

async function recordAppliedReplanMarker(db: Db, input: {
  companyId: string;
  missionId: string;
  ownerActionIssueId: string;
  decisionEventId: string;
  planningIssueId: string;
}): Promise<void> {
  await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.ownerActionIssueId,
    eventType: MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE,
    layer: MISSION_OWNER_RECOVERY_LAYER,
    decision: "replan_mission",
    reason: MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE,
    reasonCode: MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE,
    idempotencyKey: buildOwnerReplanAppliedIdempotencyKey(input.missionId, input.decisionEventId),
    payload: {
      schemaVersion: 1,
      kind: MISSION_OWNER_REPLAN_APPLIED_EVENT_TYPE,
      planningIssueId: input.planningIssueId,
      decisionEventId: input.decisionEventId,
      ownerActionIssueId: input.ownerActionIssueId,
    },
  }).onConflictDoNothing();
}

async function findOpenOwnerPlanningIssue(
  db: Db,
  input: { companyId: string; missionId: string; ownerAgentId: string },
): Promise<typeof issues.$inferSelect | null> {
  const [existing] = await db.select().from(issues).where(and(
    eq(issues.companyId, input.companyId),
    eq(issues.missionId, input.missionId),
    eq(issues.originKind, "mission_main_executor_plan"),
    eq(issues.assigneeAgentId, input.ownerAgentId),
    inArray(issues.status, RUNNABLE_PLAN_STATUSES),
    isNull(issues.hiddenAt),
  )).orderBy(desc(issues.createdAt), desc(issues.id)).limit(1);
  return existing ?? null;
}

// 결정 시점 이후 이미 [PLAN] 실체화·리비전 제출이 이뤄졌는지: ① 종결된(비-runnable) 오너 [PLAN]
// 이슈, ② 신규 plan artifact 리비전, ③ plan 결정 제출. 하나라도 있으면 결정은 이미 소멸/충족되었다.
async function hasReplanEvidenceSinceDecision(db: Db, input: {
  companyId: string;
  missionId: string;
  ownerAgentId: string | null;
  decisionCreatedAt: Date;
}): Promise<boolean> {
  if (input.ownerAgentId) {
    const [concludedPlan] = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.originKind, "mission_main_executor_plan"),
      eq(issues.assigneeAgentId, input.ownerAgentId),
      isNull(issues.hiddenAt),
      notInArray(issues.status, RUNNABLE_PLAN_STATUSES),
      gte(issues.createdAt, input.decisionCreatedAt),
    )).limit(1);
    if (concludedPlan) return true;
  }
  const [artifact] = await db.select({ id: missionPlanArtifacts.id }).from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, input.companyId),
    eq(missionPlanArtifacts.missionId, input.missionId),
    gte(missionPlanArtifacts.createdAt, input.decisionCreatedAt),
  )).limit(1);
  if (artifact) return true;
  const [submission] = await db.select({ id: missionPlanDecisionSubmissions.id }).from(missionPlanDecisionSubmissions).where(and(
    eq(missionPlanDecisionSubmissions.companyId, input.companyId),
    eq(missionPlanDecisionSubmissions.missionId, input.missionId),
    gte(missionPlanDecisionSubmissions.createdAt, input.decisionCreatedAt),
  )).limit(1);
  return Boolean(submission);
}

// [읽기 전용 판별] 과거 replan_mission 결정이 이미 소모·충족되었는지(열린 runnable [PLAN] 이면
// 진행 중 false; 마커 또는 ①·②·③ 증거가 있으면 true). 결정 레인은 recommendation·적용·웨이크
// 전에 이 헬퍼로 [PLAN] 종결 후의 허위 request_replan·중복 [PLAN]·중복 웨이크 반복을 차단한다.
export async function isOwnerReplanDecisionAlreadySatisfied(input: {
  db: Db;
  companyId: string;
  missionId: string;
  ownerAgentId: string | null;
  ownerActionIssueId: string;
  decisionEventId: string;
  decisionCreatedAt: Date;
}): Promise<boolean> {
  if (input.ownerAgentId) {
    const open = await findOpenOwnerPlanningIssue(input.db, {
      companyId: input.companyId,
      missionId: input.missionId,
      ownerAgentId: input.ownerAgentId,
    });
    if (open) return false;
  }
  const marker = await findAppliedReplanMarker(input.db, {
    companyId: input.companyId,
    missionId: input.missionId,
    decisionEventId: input.decisionEventId,
  });
  if (marker) return true;
  return hasReplanEvidenceSinceDecision(input.db, {
    companyId: input.companyId,
    missionId: input.missionId,
    ownerAgentId: input.ownerAgentId,
    decisionCreatedAt: input.decisionCreatedAt,
  });
}

/**
 * Turns an authoritative replan decision into runnable planning work.
 * Mission then owner-action row locks match decision submission order, so the latest decision and
 * current owner remain stable while an existing planning attempt is reused or a new one is created.
 * 하나의 결정(eventId)은 정확히 한 번만 실체화에 기여한다: 마커의 [PLAN] 이 종결되었으면 null,
 * ①·②·③ 충족 증거가 있으면 null, 열린 runnable [PLAN] 이면 재사용(reused), 아니면 새 [PLAN](created).
 */
export async function applyOwnerReplanDecision(input: {
  db: Db;
  mission: MissionRow;
  ownerActionIssueId: string;
  expectedDecisionEventId: string;
}): Promise<OwnerReplanApplication | null> {
  return input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [mission] = await tx
      .select({
        id: missions.id,
        companyId: missions.companyId,
        ownerAgentId: missions.ownerAgentId,
        title: missions.title,
        description: missions.description,
        status: missions.status,
      })
      .from(missions)
      .where(and(eq(missions.companyId, input.mission.companyId), eq(missions.id, input.mission.id)))
      .for("update");
    if (!mission || mission.status === "completed" || mission.status === "cancelled") return null;

    const [ownerAction] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.id, input.ownerActionIssueId),
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
      ))
      .for("update");
    if (!ownerAction) return null;

    const currentDecision = await loadLatestMissionOwnerDecision({
      db: tx,
      companyId: mission.companyId,
      ownerActionIssueId: ownerAction.id,
    });
    if (
      currentDecision?.eventId !== input.expectedDecisionEventId
      || currentDecision.missionId !== mission.id
      || currentDecision.authorAgentId !== mission.ownerAgentId
      || currentDecision.decision.decision !== "replan_mission"
    ) return null;

    // (A) 이 결정의 적용 마커: 이미 실체화에 한 번 기여했다. 마커가 가리키는 [PLAN] 이 아직
    // 열려 있으면 그것을 재사용하고, 종결/숨김/누락되었으면 결정은 소모 완료 — 새 [PLAN] 금지.
    const marker = await findAppliedReplanMarker(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      decisionEventId: currentDecision.eventId,
    });
    if (marker) {
      const planningIssueId = markerPlanningIssueId(marker);
      if (planningIssueId) {
        const [planningIssue] = await tx.select().from(issues).where(and(
          eq(issues.companyId, mission.companyId),
          eq(issues.missionId, mission.id),
          eq(issues.id, planningIssueId),
        )).limit(1);
        if (planningIssue && !planningIssue.hiddenAt
          && planningIssue.assigneeAgentId === mission.ownerAgentId
          && RUNNABLE_PLAN_STATUSES.includes(planningIssue.status)) {
          return { planningIssue, resultStatus: "reused" };
        }
      }
      return null;
    }

    // (B-1) 레거시/수동 생성 호환: 마커 없이 열린 runnable 오너 [PLAN] 이 있으면 이 결정을
    // 그 이슈에 묶어 마커를 남기고 재사용한다(계약: 동일 idempotencyKey 로 웨이크 재발송).
    const existing = await findOpenOwnerPlanningIssue(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      ownerAgentId: mission.ownerAgentId,
    });
    if (existing) {
      await recordAppliedReplanMarker(txDb, {
        companyId: mission.companyId,
        missionId: mission.id,
        ownerActionIssueId: ownerAction.id,
        decisionEventId: currentDecision.eventId,
        planningIssueId: existing.id,
      });
      return { planningIssue: existing, resultStatus: "reused" };
    }

    // (B-2) 새 [PLAN] 생성 전, 결정이 이미 충족/대체되었는지 검사(①이슈 ②아티팩트 ③제출).
    const alreadySatisfied = await hasReplanEvidenceSinceDecision(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      ownerAgentId: mission.ownerAgentId,
      decisionCreatedAt: currentDecision.createdAt,
    });
    if (alreadySatisfied) return null;

    // (B-3) 신규 [PLAN] 생성 + 같은 트랜잭션에서 적용 마커 기록.
    const candidates = await listCompanyExecutionCandidates(txDb, mission.companyId);
    const planTemplateCatalog = await missionPlanTemplateService(txDb).list(mission.companyId, { includeDisabled: false });
    const description = await buildRevisionMissionPlanningDescription(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      title: mission.title,
      description: mission.description,
      runnableCandidates: candidates,
      runnableRosterLines: formatCandidateRosterLines(candidates, mission.ownerAgentId),
      planTemplateCatalog,
    });
    const planningIssue = await createIssueRecord(
      tx,
      mission.companyId,
      {
        assigneeAgentId: mission.ownerAgentId,
        description,
        missionId: mission.id,
        originKind: "mission_main_executor_plan",
        originId: ownerAction.id,
        priority: "medium",
        status: "todo",
        title: `[PLAN] ${mission.title}`,
      },
      false,
    );
    await recordAppliedReplanMarker(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      ownerActionIssueId: ownerAction.id,
      decisionEventId: currentDecision.eventId,
      planningIssueId: planningIssue.id,
    });
    return { planningIssue, resultStatus: "created" };
  });
}
