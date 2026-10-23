// 구조적 owner 결정 조회·검증. 표시용 자연어는 실행 권위로 읽지 않는다.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import {
  MISSION_OWNER_DECISION_EVENT_TYPE,
  MISSION_OWNER_DECISION_SOURCE,
  MISSION_OWNER_RECOVERY_LAYER,
  normalizeSubmission,
  submissionToDecision,
  type MissionOwnerDecisionRecord,
  type MissionOwnerRecoveryLedgerDb,
} from "./mission-owner-decision-contract.js";

export async function loadLatestMissionOwnerDecision(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly companyId: string;
  readonly ownerActionIssueId?: string;
  readonly missionId?: string | null;
  readonly since?: Date | null;
}): Promise<MissionOwnerDecisionRecord | null> {
  const ownerActionIssueId = input.ownerActionIssueId;
  const conditions = [
    eq(workflowTransitionEvents.companyId, input.companyId),
    eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
    eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
    // [source marker filter] 고정 reason marker 가 있는 row 만 권위. legacy/parser-derived row 무시.
    eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
    // [authorship integrity] heartbeat run 의 company 가 event company 와, 그리고 heartbeat issue 가
    //   event issue(owner-action issue) 와 무조건 일치해야 한다(단순 run-id join 이 아님, missionId-only
    //   조회에서도 동일). 일치하지 않거나 run 이 없으면 fail closed.
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.issueId, workflowTransitionEvents.issueId),
  ];
  if (ownerActionIssueId) {
    conditions.push(eq(workflowTransitionEvents.issueId, ownerActionIssueId));
  }
  if (input.missionId) {
    conditions.push(eq(workflowTransitionEvents.missionId, input.missionId));
  }
  if (input.since) {
    conditions.push(gte(workflowTransitionEvents.createdAt, input.since));
  }

  const rows = await input.db
    .select({
      id: workflowTransitionEvents.id,
      createdAt: workflowTransitionEvents.createdAt,
      issueId: workflowTransitionEvents.issueId,
      missionId: workflowTransitionEvents.missionId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      payload: workflowTransitionEvents.payload,
      agentId: heartbeatRuns.agentId,
    })
    .from(workflowTransitionEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, workflowTransitionEvents.heartbeatRunId))
    .where(and(...conditions))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(8);

  for (const row of rows) {
    const record = rowToDecisionRecord(row);
    if (record) return record;
  }
  return null;
}

function rowToDecisionRecord(row: {
  id: string; createdAt: Date; issueId: string | null; missionId: string | null;
  heartbeatRunId: string | null; payload: Record<string, unknown> | null; agentId: string | null;
}): MissionOwnerDecisionRecord | null {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (payload.kind !== MISSION_OWNER_DECISION_EVENT_TYPE) return null;
  if (payload.source !== MISSION_OWNER_DECISION_SOURCE) return null;
  if (!row.issueId || payload.ownerActionIssueId !== row.issueId) return null;
  const submission = normalizeSubmission({
    decision: typeof payload.decision === "string" ? payload.decision : "",
    recoveryTarget: payload.recoveryTarget,
    sourceIssueRef: typeof payload.sourceIssueRef === "string" ? payload.sourceIssueRef : null,
    reworkTargetRef: typeof payload.reworkTargetRef === "string" ? payload.reworkTargetRef : null,
    targetAgentId: typeof payload.targetAgentId === "string" ? payload.targetAgentId : null,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    nextAction: typeof payload.nextAction === "string" ? payload.nextAction : null,
    evidence: typeof payload.evidence === "string" ? payload.evidence : null,
  });
  if (!submission || !row.agentId) return null;
  return {
    eventId: row.id,
    createdAt: row.createdAt,
    ownerActionIssueId: row.issueId,
    missionId: row.missionId,
    sourceIssueId: typeof payload.sourceIssueId === "string" ? payload.sourceIssueId : null,
    heartbeatRunId: row.heartbeatRunId,
    authorAgentId: row.agentId,
    commentId: typeof payload.commentId === "string" ? payload.commentId : null,
    decision: submissionToDecision(submission),
  };
}

// [governance display] 미션 스코프의 모든 구조 owner decision record(author proven). display/human-report
//   용; execution authority 는 loadLatest/validate 경로를 사용한다.
export async function loadMissionOwnerDecisions(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly companyId: string;
  readonly missionId: string;
  readonly issueIds?: ReadonlySet<string>;
}): Promise<MissionOwnerDecisionRecord[]> {
  const issueFilter = input.issueIds && input.issueIds.size > 0 ? Array.from(input.issueIds) : null;
  const rows = await input.db
    .select({
      id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt,
      issueId: workflowTransitionEvents.issueId, missionId: workflowTransitionEvents.missionId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId, payload: workflowTransitionEvents.payload,
      agentId: heartbeatRuns.agentId,
    })
    .from(workflowTransitionEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, workflowTransitionEvents.heartbeatRunId))
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.missionId, input.missionId),
      eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
      eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
      eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, workflowTransitionEvents.issueId),
      ...(issueFilter ? [inArray(workflowTransitionEvents.issueId, issueFilter)] : []),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(64);
  const records: MissionOwnerDecisionRecord[] = [];
  for (const row of rows) {
    const record = rowToDecisionRecord(row);
    if (record) records.push(record);
  }
  return records;
}

// [cap-override authority] 가장 최근 owner-action 결정이 retry_source_issue 이고 producer 를 정확히
//   타겟하며 owner agent 가 author 인지 검증. caller 가 전달한 decisionEventId 가 latest record 와
//   정확히 일치해야 한다(unconditional). 자연어 comment 는 더 이상 권위가 아니다.
export async function validateOwnerDecisionEvent(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly companyId: string;
  readonly ownerActionIssueId: string;
  readonly missionOwnerAgentId: string;
  readonly producerIssueId: string;
  readonly producerIdentifier: string | null;
  readonly producerCompletedAt: Date | null;
  // [exact event authority — required] supplied id 가 latest record.eventId 와 정확히 일치해야 한다.
  readonly decisionEventId: string;
}): Promise<{ eventId: string; createdAt: Date } | null> {
  const record = await loadLatestMissionOwnerDecision({
    db: input.db,
    companyId: input.companyId,
    ownerActionIssueId: input.ownerActionIssueId,
  });
  if (!record || record.decision.decision !== "retry_source_issue") return null;
  // [strict authorship] author 가 owner agent 와 정확히 일치하지 않으면 거부. null author 불가(inner join).
  if (record.authorAgentId !== input.missionOwnerAgentId) return null;
  // [exact event authority — unconditional] 다른 id(stale/다른 결정)면 거부.
  if (record.eventId !== input.decisionEventId) return null;
  if (input.producerCompletedAt && record.createdAt.getTime() < input.producerCompletedAt.getTime()) return null;

  const targetRef = (record.decision.reworkTargetRef ?? record.decision.sourceIssueRef ?? "").trim().toLowerCase();
  const producerTokens = [input.producerIssueId, input.producerIdentifier]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (!targetRef || !producerTokens.includes(targetRef)) return null;
  return { eventId: record.eventId, createdAt: record.createdAt };
}

// [stale-source diagnosis authority] 해당 source issue 에 대한 구조적 owner recovery 결정이 존재하는지.
//   자연어 comment 의 keyword/heading 은 더 이상 진단 신호가 아니다 — 구조 이벤트만 권위.
export async function hasStructuredSourceRecoveryDecision(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly companyId: string;
  readonly sourceIssueId: string;
}): Promise<boolean> {
  const ownerActions = await input.db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.originId, input.sourceIssueId),
      eq(issues.originKind, "mission_main_executor_unblock"),
    ))
    .limit(8);
  for (const ownerAction of ownerActions) {
    const record = await loadLatestMissionOwnerDecision({
      db: input.db,
      companyId: input.companyId,
      ownerActionIssueId: ownerAction.id,
    });
    if (record) return true;
  }
  return false;
}
