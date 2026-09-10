import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowDelegations,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";
import { legacyHistoryPredicates } from "./read-model-legacy.js";

/**
 * [파일 목적] Task5c2a scoped read-model 의 이력 조회부(계약 4-7: issues/wakeups/
 *   heartbeats/delegations). read-model.ts 의 내부 추출 헬퍼로, frozen step set 검증이
 *   끝난 뒤에만 호출된다. reader 자체와 마찬가지로 SELECT 표면만 사용한다.
 * [불변식]
 *   - SELECT 만: transaction/lock/SET 시작 금지, 쓰기·lazy write callback 없음.
 *   - 회사 경계: 조회를 company 로 좁히지 않는 대신(타회사 오염 참조가 숨겨지는 것을 막기 위해)
 *     반환된 모든 행의 company 를 검증해 scope_mismatch 로 거부한다. mission/run 소속 행은
 *     예외 없이 전부 검증 대상이다.
 *   - 빈 id 집합에는 inArray 를 만들지 않는다 — 비어있지 않은 술어만 조립해
 *     invalid SQL(`in ()`)과 전체 스캔(where 미정의)을 동시에 회피한다.
 *   - 모든 목록은 table.id 오름차순(결정적). status/executionGeneration/lease 상태 등으로
 *     걸러내지 않는다 — 이전 generation·만료 lease·미지 status·해제된 owner 모두 raw 이력.
 *   - delegation 은 scope 쪽 면만 검증한다: source 연관(run/step/sourceIssue)엔
 *     sourceCompanyId, targetIssue 연관엔 targetCompanyId. 타회사 counterpart 자체는
 *     유효한 delegation 이력이라 그대로 보존하며, target 회사 레코드를 Fetch 하지 않는다.
 * [Task5c2b] legacy JSON-only 연관: heartbeat.contextSnapshot / wakeup payload 의 최상위 문자열
 *   키(missionId/workflowRunId/workflowStepRunId/issueId/taskId/taskKey) 정확 동등 참조도 이제
 *   조회에 포함된다(read-model-legacy). 이는 과거 실행 연관의 "수집"일 뿐이며, JSON 링크만으로
 *   완전한 lineage/quiescence/evidence 를 주장하지 않는다 — 승인 근거 판정은 이후 슬라이스 소관.
 * [한계] metadata.toolQueue/toolInvocation 과 dispatch 필드는 step 전체 행 안에 그대로 보존되며
 *   별도 tool queue 테이블을 발명하지 않는다.
 */

interface Scope {
  companyId: string;
  missionId: string;
  workflowRunId: string;
}

export interface ResumeScopedHistory {
  issues: (typeof issues.$inferSelect)[];
  wakeups: (typeof agentWakeupRequests.$inferSelect)[];
  heartbeats: (typeof heartbeatRuns.$inferSelect)[];
  delegations: (typeof workflowDelegations.$inferSelect)[];
}

type StepRunRow = typeof workflowStepRuns.$inferSelect;

function scopeMismatch(reason: string) {
  return unprocessable("scope_mismatch", { reason });
}

function historyUnproven(reason: string) {
  return unprocessable("resume_history_unproven", { reason });
}

function nonNullIds(values: (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null);
}

/** 계약 4-7 전체. steps 는 이미 step-set 검증을 통과한 전체 행(비어있지 않음)이다. */
export async function readResumeScopedHistory(
  db: Pick<Db, "select">,
  scope: Scope,
  steps: StepRunRow[],
): Promise<ResumeScopedHistory> {
  const scopedIssues = await readScopedIssues(db, scope, steps);
  const issueIds = scopedIssues.map((row) => row.id);
  const stepRunIds = steps.map((row) => row.id);
  const wakeups = await readScopedWakeups(db, scope, stepRunIds, issueIds, steps);
  const heartbeats = await readScopedHeartbeats(db, scope, stepRunIds, issueIds, wakeups, steps, scopedIssues);
  const delegations = await readScopedDelegations(db, scope, stepRunIds, issueIds);
  return { issues: scopedIssues, wakeups, heartbeats, delegations };
}

/** 계약 4: mission-linked(company+mission) OR step-linked(id IN). 누락/오염 이슈 거부. */
async function readScopedIssues(
  db: Pick<Db, "select">,
  scope: Scope,
  steps: StepRunRow[],
): Promise<ResumeScopedHistory["issues"]> {
  const stepIssueIds = nonNullIds(steps.map((row) => row.issueId));
  const predicates: (SQL<unknown> | undefined)[] = [
    and(eq(issues.companyId, scope.companyId), eq(issues.missionId, scope.missionId)),
  ];
  if (stepIssueIds.length > 0) predicates.push(inArray(issues.id, stepIssueIds));
  const rows = await db.select().from(issues).where(or(...predicates)).orderBy(issues.id);

  const found = new Set<string>();
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("issue_company_mismatch");
    // step-linked 이슈는 null missionId 허용(역사적 step 연관), nonnull 타 mission 은 거부.
    if (row.missionId !== null && row.missionId !== scope.missionId) {
      throw scopeMismatch("issue_mission_mismatch");
    }
    found.add(row.id);
  }
  for (const issueId of stepIssueIds) {
    if (!found.has(issueId)) throw historyUnproven("missing_issue");
  }
  return rows;
}

/** 계약 5: mission/run/step/issue/owner-id + payload legacy JSON 연관 전부 포함 — company 좁힘 없이 검증. */
async function readScopedWakeups(
  db: Pick<Db, "select">,
  scope: Scope,
  stepRunIds: string[],
  issueIds: string[],
  steps: StepRunRow[],
): Promise<ResumeScopedHistory["wakeups"]> {
  const predicates: (SQL<unknown> | undefined)[] = [
    eq(agentWakeupRequests.missionId, scope.missionId),
    eq(agentWakeupRequests.workflowRunId, scope.workflowRunId),
  ];
  if (stepRunIds.length > 0) predicates.push(inArray(agentWakeupRequests.workflowStepRunId, stepRunIds));
  if (issueIds.length > 0) predicates.push(inArray(agentWakeupRequests.issueId, issueIds));
  const ownerWakeupIds = nonNullIds(steps.map((row) => row.dispatchOwnerWakeupRequestId));
  if (ownerWakeupIds.length > 0) predicates.push(inArray(agentWakeupRequests.id, ownerWakeupIds));
  // [Task5c2b] legacy payload JSON 연관 — typed 컬럼이 비어 있어도 최상위 문자열 참조를 발견한다.
  //   JSON 링크는 resume 승인 근거가 아니라 수집 대상 연관이며, 반환 행의 company 검증은 아래에서 동일 적용.
  predicates.push(...legacyHistoryPredicates(agentWakeupRequests.payload, scope, stepRunIds, issueIds));
  const rows = await db.select().from(agentWakeupRequests)
    .where(or(...predicates)).orderBy(agentWakeupRequests.id);

  const found = new Set<string>();
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("wakeup_company_mismatch");
    found.add(row.id);
  }
  for (const wakeupId of ownerWakeupIds) {
    if (!found.has(wakeupId)) throw historyUnproven("missing_wakeup_owner");
  }
  return rows;
}

/** 계약 6: step/issue/wakeup-id/owner-id + contextSnapshot legacy JSON 연관. generation·status 제한 없음. */
async function readScopedHeartbeats(
  db: Pick<Db, "select">,
  scope: Scope,
  stepRunIds: string[],
  issueIds: string[],
  wakeups: ResumeScopedHistory["wakeups"],
  steps: StepRunRow[],
  scopedIssues: ResumeScopedHistory["issues"],
): Promise<ResumeScopedHistory["heartbeats"]> {
  const predicates: (SQL<unknown> | undefined)[] = [];
  if (stepRunIds.length > 0) predicates.push(inArray(heartbeatRuns.workflowStepRunId, stepRunIds));
  if (issueIds.length > 0) predicates.push(inArray(heartbeatRuns.issueId, issueIds));
  const wakeupIds = wakeups.map((row) => row.id);
  if (wakeupIds.length > 0) predicates.push(inArray(heartbeatRuns.wakeupRequestId, wakeupIds));
  const ownerHeartbeatIds = nonNullIds([
    ...steps.map((row) => row.dispatchOwnerHeartbeatRunId),
    ...scopedIssues.map((row) => row.checkoutRunId),
    ...scopedIssues.map((row) => row.executionRunId),
  ]);
  if (ownerHeartbeatIds.length > 0) predicates.push(inArray(heartbeatRuns.id, ownerHeartbeatIds));
  // [Task5c2b] legacy contextSnapshot JSON 연관 — payload 와 동일한 최소 술어 세트.
  predicates.push(...legacyHistoryPredicates(heartbeatRuns.contextSnapshot, scope, stepRunIds, issueIds));
  // [방어] 술어가 하나도 없으면 where 미정의 = 전체 스캔이 되므로 조회하지 않는다.
  if (predicates.length === 0) return [];
  const rows = await db.select().from(heartbeatRuns).where(or(...predicates)).orderBy(heartbeatRuns.id);

  const found = new Set<string>();
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("heartbeat_company_mismatch");
    found.add(row.id);
  }
  for (const heartbeatId of ownerHeartbeatIds) {
    if (!found.has(heartbeatId)) throw historyUnproven("missing_heartbeat_owner");
  }
  return rows;
}

/** 계약 7: source(run/step/sourceIssue)·targetIssue 연관. scope 쪽 면만 회사 검증. */
async function readScopedDelegations(
  db: Pick<Db, "select">,
  scope: Scope,
  stepRunIds: string[],
  issueIds: string[],
): Promise<ResumeScopedHistory["delegations"]> {
  const predicates: (SQL<unknown> | undefined)[] = [
    eq(workflowDelegations.sourceWorkflowRunId, scope.workflowRunId),
  ];
  if (stepRunIds.length > 0) predicates.push(inArray(workflowDelegations.sourceWorkflowStepRunId, stepRunIds));
  if (issueIds.length > 0) {
    predicates.push(inArray(workflowDelegations.sourceIssueId, issueIds));
    predicates.push(inArray(workflowDelegations.targetIssueId, issueIds));
  }
  const rows = await db.select().from(workflowDelegations)
    .where(or(...predicates)).orderBy(workflowDelegations.id);

  const stepIdSet = new Set(stepRunIds);
  const issueIdSet = new Set(issueIds);
  for (const row of rows) {
    const sourceLinked = row.sourceWorkflowRunId === scope.workflowRunId
      || stepIdSet.has(row.sourceWorkflowStepRunId)
      || (row.sourceIssueId !== null && issueIdSet.has(row.sourceIssueId));
    const targetLinked = issueIdSet.has(row.targetIssueId);
    if (sourceLinked && row.sourceCompanyId !== scope.companyId) {
      throw scopeMismatch("delegation_source_company_mismatch");
    }
    if (targetLinked && row.targetCompanyId !== scope.companyId) {
      throw scopeMismatch("delegation_target_company_mismatch");
    }
  }
  return rows;
}
