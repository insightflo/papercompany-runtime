// server/src/services/missions/stale-source-wakeup-gate.ts
//
// [목적] stale-source 웨이크업 게이트. 2026-11-12 netdata 사고(c8393310)에서 in_progress+종결 실패 런
//   이슈가 30분 주기 감독에 매번 diagnosed_only 로만 남아 영구 정체했다 — 주기 감독이
//   dispatchStaleSourceIssueWakeups=false 하드코딩이고, 이 클래스에는 구조화 판정(앵커+오너 결정)
//   충족 경로 자체가 없었다. 이 모듈은 (1) 인스턴스/미션 설정 게이트, (2) 같은 진단 반복 카운트,
//   (3) 사람 승인(resolve+continuation accepted) 복구 판정 인정을 구조화 레코드로만 제공한다.
// [외부 연결] caller: mission-owner-supervision-monitor.ts(전역 게이트), missions/supervision-main.ts
//   (미션·이슈 단위 유효 게이트). 설정 원본: instance_settings.experimental(단일 행, 스키마
//   instanceExperimentalSettingsSchema). 마커: workflowTransitionEvents(자연어 파싱 금지 규칙 준수).
// [수정시 주의] 카운트·판정은 (회사, 소스 이슈, 최근 종결 실패 런) 조합에만 묶는다 — 특정 미션·이슈
//   하드코딩 금지. 판정 존재 여부와 반복 횟수는 "자동 깨움 허용"의 두 조건으로만 쓰고, 이미 발사된
//   웨이크업 멱등(hasRecoveryIdempotency)은 여기서 다루지 않는다.
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  instanceSettings,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";

const DEFAULT_SINGLETON_KEY = "default";

/** 같은 (소스 이슈, 최근 실패 런) 진단이 이 횟수 반복되고 구조화 판정이 있으면 자동 깨움을 허용한다. */
export const STALE_SOURCE_WAKEUP_AUTO_THRESHOLD = 3;
export const STALE_SOURCE_WAKEUP_DIAGNOSIS_EVENT = "mission_stale_source_wakeup_diagnosis";

type SettingsReader = Pick<Db, "select">;

/**
 * 인스턴스/미션 설정 게이트 — 기본 off(진단만). enableStaleSourceIssueWakeupV1(전체) 또는
 *   staleSourceIssueWakeupAllowedMissionIdsV1(미션 단위 부분 롤아웃)이 켜지면 자동 깨움 경로를 연다.
 *   설정 행 부재·불량은 fail-closed(false). 모니터는 missionId 없이 전역 여부만, per-mission 감독은
 *   missionId 를 넘겨 목록 매칭까지 평가한다.
 */
export async function isStaleSourceWakeupEnabled(
  db: SettingsReader,
  missionId?: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY));
  const settings = (Array.isArray(rows) ? rows[0] : undefined)?.experimental;
  if (settings?.enableStaleSourceIssueWakeupV1 === true) return true;
  const allowed = settings?.staleSourceIssueWakeupAllowedMissionIdsV1;
  return Boolean(missionId) && Array.isArray(allowed) && allowed.includes(missionId as string);
}

function diagnosisCorrelationId(sourceIssueId: string, failedRunId: string): string {
  return `stale-source-diagnosis:${sourceIssueId}:${failedRunId}`;
}

/**
 * 같은 진단 1틱 1마커 — "stale_in_progress + 최근 종결 실패 런 + 실행 증거 없음" 진단이 미발사로
 *   반복될 때 감독 호출이 1회 기록한다. occurredAt 이 키에 들어가 같은 틱 재실행은 멱등 합류하고
 *   다른 틱은 새 카운트가 된다(죽은 대상 브레이커의 not_applied 마커와 같은 원리).
 */
export async function recordStaleSourceWakeupDiagnosis(db: Db, input: {
  readonly companyId: string;
  readonly missionId: string;
  readonly sourceIssueId: string;
  readonly failedRunId: string;
  readonly occurredAt: Date;
}): Promise<void> {
  await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.sourceIssueId,
    eventType: STALE_SOURCE_WAKEUP_DIAGNOSIS_EVENT,
    layer: "mission_owner_recovery",
    toStatus: "diagnosed_only",
    correlationId: diagnosisCorrelationId(input.sourceIssueId, input.failedRunId),
    idempotencyKey: [
      STALE_SOURCE_WAKEUP_DIAGNOSIS_EVENT,
      input.sourceIssueId,
      input.failedRunId,
      input.occurredAt.toISOString(),
    ].join(":"),
    payload: {
      kind: STALE_SOURCE_WAKEUP_DIAGNOSIS_EVENT,
      sourceIssueId: input.sourceIssueId,
      failedRunId: input.failedRunId,
      diagnosis: "stale_in_progress_after_failed_run",
    },
  }).onConflictDoNothing();
}

/** 같은 (소스 이슈, 실패 런) 진단의 누적 반복 횟수. 자동 깨움 임계 판정 근거. */
export async function countStaleSourceWakeupDiagnoses(db: Db, input: {
  readonly companyId: string;
  readonly sourceIssueId: string;
  readonly failedRunId: string;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.eventType, STALE_SOURCE_WAKEUP_DIAGNOSIS_EVENT),
      eq(workflowTransitionEvents.correlationId, diagnosisCorrelationId(input.sourceIssueId, input.failedRunId)),
    ));
  return row?.count ?? 0;
}

/**
 * [사람 승인 이력 = 구조화 복구 판정] 소스 이슈 또는 그 언블록 앵커(owner-action)에 붙은 사람 결정
 *   카드가 resolve 되고 continuation 이 accepted(웨이크 실제 전달)까지 간 기록을 판정으로 인정한다.
 *   카드 본문·선택지 자연어는 읽지 않는다 — operator_decisions.status='resolved' +
 *   operator_decision_continuations.state='accepted' 두 구조 필드만 본다(규칙 9).
 *   since(최근 실패 런 시각) 이전의 승인은 이 실패에 대한 판단이 아니므로 인정하지 않는다.
 */
export async function hasAcceptedHumanApprovalForSource(
  db: SettingsReader,
  input: {
    readonly companyId: string;
    readonly sourceIssueId: string;
    readonly since?: Date | null;
  },
): Promise<boolean> {
  const anchors = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      or(
        eq(issues.id, input.sourceIssueId),
        and(
          eq(issues.originId, input.sourceIssueId),
          eq(issues.originKind, "mission_main_executor_unblock"),
        ),
      ),
    ))
    .limit(16);
  const anchorIds = anchors.map((row) => row.id);
  if (anchorIds.length === 0) return false;
  const [row] = await db
    .select({ id: operatorDecisions.id })
    .from(operatorDecisions)
    .innerJoin(
      operatorDecisionContinuations,
      eq(operatorDecisionContinuations.operatorDecisionId, operatorDecisions.id),
    )
    .where(and(
      eq(operatorDecisions.companyId, input.companyId),
      eq(operatorDecisions.status, "resolved"),
      inArray(operatorDecisions.issueId, anchorIds),
      eq(operatorDecisionContinuations.companyId, input.companyId),
      eq(operatorDecisionContinuations.state, "accepted"),
      ...(input.since
        ? [gte(operatorDecisionContinuations.acceptedAt, input.since)]
        : []),
    ))
    .limit(1);
  return Boolean(row);
}
