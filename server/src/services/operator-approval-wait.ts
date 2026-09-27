import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, operatorDecisions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// [approval-waiting marker] 승인 대기 관찰 가능성 마커(로드맵 ④).
// 단일 사실 원천은 기존 내구 데이터뿐이다 — pending operator_decisions 와
// 미결 approvals(issue_approvals 조인). 이 모듈은 파생 판정만 제공하고
// 아무것도 저장하지 않는다(AGENTS.md 규칙 9: 자연어/파생값은 실행 권위가 아님).
// 대기 상태 어휘:
//   - operator_decisions.status = 'pending' (사람 결정 대기)
//   - approvals.status in ('pending', 'revision_requested') (사람 승인/수정요청 대기)
const OPERATOR_DECISION_WAITING_STATUS = "pending";
const APPROVAL_WAITING_STATUSES: string[] = ["pending", "revision_requested"];

export interface OperatorApprovalWaitMarker {
  waiting: boolean;
  operatorDecisionIds: string[];
  approvalIds: string[];
}

export const NOT_WAITING_ON_OPERATOR_APPROVAL: OperatorApprovalWaitMarker = {
  waiting: false,
  operatorDecisionIds: [],
  approvalIds: [],
};

export function operatorApprovalWaitService(db: Db) {
  // 배치 판정: 이슈 id 집합에 대해 pending 결정/미결 승인을 각 1회 쿼리로 조회한다.
  // operator_decisions(issueId 부분 인덱스) + issue_approvals(issueId 인덱스) 조인 — 스캔 N+1 금지.
  async function markersForIssueIds(
    issueIds: ReadonlyArray<string>,
  ): Promise<Map<string, OperatorApprovalWaitMarker>> {
    const uniqueIssueIds = Array.from(
      new Set(issueIds.filter((id) => typeof id === "string" && id.length > 0)),
    );
    const map = new Map<string, OperatorApprovalWaitMarker>();
    if (uniqueIssueIds.length === 0) return map;
    for (const issueId of uniqueIssueIds) {
      map.set(issueId, { waiting: false, operatorDecisionIds: [], approvalIds: [] });
    }

    const [decisionRows, approvalRows] = await Promise.all([
      db
        .select({ id: operatorDecisions.id, issueId: operatorDecisions.issueId })
        .from(operatorDecisions)
        .where(
          and(
            eq(operatorDecisions.status, OPERATOR_DECISION_WAITING_STATUS),
            inArray(operatorDecisions.issueId, uniqueIssueIds),
          ),
        ),
      db
        .select({ id: approvals.id, issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(
          and(
            inArray(approvals.status, APPROVAL_WAITING_STATUSES),
            inArray(issueApprovals.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of decisionRows) {
      const marker = row.issueId ? map.get(row.issueId) : undefined;
      if (!marker) continue;
      marker.operatorDecisionIds.push(row.id);
      marker.waiting = true;
    }
    for (const row of approvalRows) {
      const marker = map.get(row.issueId);
      if (!marker) continue;
      marker.approvalIds.push(row.id);
      marker.waiting = true;
    }
    return map;
  }

  async function markerForIssue(issueId: string): Promise<OperatorApprovalWaitMarker> {
    const map = await markersForIssueIds([issueId]);
    return map.get(issueId) ?? NOT_WAITING_ON_OPERATOR_APPROVAL;
  }

  // 워크플로 런 키 마커 — QA 거부 소유자 카드는 sourceId='<workflowRunId>:...' 접두사로,
  // 일반 결정은 sourceContext.workflowRunId 로 런을 참조한다.
  // (companyId, status) 인덱스로 pending 행을 좁힌 뒤 런 조건을 필터한다.
  async function markerForWorkflowRun(
    companyId: string,
    workflowRunId: string,
  ): Promise<OperatorApprovalWaitMarker> {
    const rows = await db
      .select({ id: operatorDecisions.id })
      .from(operatorDecisions)
      .where(
        and(
          eq(operatorDecisions.companyId, companyId),
          eq(operatorDecisions.status, OPERATOR_DECISION_WAITING_STATUS),
          or(
            sql`${operatorDecisions.sourceContext} ->> 'workflowRunId' = ${workflowRunId}`,
            like(operatorDecisions.sourceId, `${workflowRunId}:%`),
          ),
        ),
      );
    const operatorDecisionIds = rows.map((row) => row.id);
    return {
      waiting: operatorDecisionIds.length > 0,
      operatorDecisionIds,
      approvalIds: [],
    };
  }

  return { markersForIssueIds, markerForIssue, markerForWorkflowRun };
}

// [approval-waiting marker] 조회 라우트용 안전 래퍼 — 파생 필드는 관찰 용도라서
// 판정 쿼리 실패 시 본체 리소스 조회를 깨뜨리지 않고 미대기로 낮춘다(warn 로그만 남긴다).
// 스위프/감독 면제 경로는 이 래퍼를 쓰지 않는다 — 판정 실패는 기존 정책 동작으로 실패 닫힘.
export async function safeMarkerForIssue(
  db: Db,
  issueId: string,
): Promise<OperatorApprovalWaitMarker> {
  try {
    return await operatorApprovalWaitService(db).markerForIssue(issueId);
  } catch (err) {
    logger.warn({ err, issueId }, "operator approval wait marker lookup failed; serving not-waiting");
    return NOT_WAITING_ON_OPERATOR_APPROVAL;
  }
}

export async function safeMarkerForWorkflowRun(
  db: Db,
  companyId: string,
  workflowRunId: string,
): Promise<OperatorApprovalWaitMarker> {
  try {
    return await operatorApprovalWaitService(db).markerForWorkflowRun(companyId, workflowRunId);
  } catch (err) {
    logger.warn({ err, companyId, workflowRunId }, "operator approval wait marker lookup failed; serving not-waiting");
    return NOT_WAITING_ON_OPERATOR_APPROVAL;
  }
}
