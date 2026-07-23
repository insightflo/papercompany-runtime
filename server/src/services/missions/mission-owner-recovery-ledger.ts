// server/src/services/missions/mission-owner-recovery-ledger.ts
//
// [목적] mission-owner recovery 결정의 구조적 권위 기록. 자연어 comment parsing 을 실행 권위에서
//   제거하고, workflow_transition_events 에 company/mission/owner-action/source-issue scoped 구조 이벤트로
//   영속화한다. Supervision/cap-override/QA-cap-oversight/heartbeat/human-report consumer 는 오직 이
//   reader 를 통해 결정을 읽는다. 표시용 comment 는 dual-write 될 수 있으나 권위로 read-back 금지.
// [외부 연결] writer: agent API(routes/mission-owner-recovery-agent-api), reader: supervision/cap-override/
//   QA-cap/heartbeat/human-report.
// [수정시 주의] 스키마 변경 없음(workflow_transition_events 재사용). row 는 고정 source marker
//   (reason/reasonCode=owner_recovery_api) 로 식별된다. authorship 은 payload+heartbeat run(companyId+issueId
//   정합) 로 검증한다.
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { ExtractedMissionOwnerDecision, MissionOwnerDecisionOption } from "./mission-owner-recovery-events.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "./mission-owner-recovery-events.js";

export const MISSION_OWNER_RECOVERY_LAYER = "mission_owner_recovery";
export const MISSION_OWNER_DECISION_EVENT_TYPE = "mission_owner_decision";
// [immutable source marker] 구조 제출(row)을 식별하는 고정 reason/reasonCode. user free-text reason
//   은 payload 에만 저장하고 workflowTransitionEvents.reason 열에 넣지 않는다. 모든 reader 가 이
//   marker 를 필터링하여 legacy/parser-derived row 가 무시되도록 한다.
export const MISSION_OWNER_DECISION_SOURCE = "owner_recovery_api";

export type MissionOwnerDecisionSubmission = {
  readonly decision: MissionOwnerDecisionOption;
  readonly sourceIssueRef?: string;
  readonly reworkTargetRef?: string;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
};

export type MissionOwnerDecisionRecord = {
  readonly eventId: string;
  readonly createdAt: Date;
  readonly ownerActionIssueId: string;
  readonly missionId: string | null;
  readonly sourceIssueId: string | null;
  readonly heartbeatRunId: string | null;
  readonly authorAgentId: string;
  readonly commentId: string | null;
  readonly decision: ExtractedMissionOwnerDecision;
};

export type MissionOwnerRecoveryLedgerDb = Pick<Db, "select" | "insert">;

type OwnerActionIssue = {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
};

function normalizeSubmission(raw: {
  decision: string;
  sourceIssueRef?: string | null;
  reworkTargetRef?: string | null;
  reason?: string | null;
  nextAction?: string | null;
  evidence?: string | null;
}): MissionOwnerDecisionSubmission | null {
  if (!MISSION_OWNER_DECISION_OPTIONS.includes(raw.decision as MissionOwnerDecisionOption)) return null;
  const trimmed = (value: string | null | undefined): string | undefined => {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized ? normalized : undefined;
  };
  return {
    decision: raw.decision as MissionOwnerDecisionOption,
    ...(trimmed(raw.sourceIssueRef) ? { sourceIssueRef: trimmed(raw.sourceIssueRef) } : {}),
    ...(trimmed(raw.reworkTargetRef) ? { reworkTargetRef: trimmed(raw.reworkTargetRef) } : {}),
    ...(trimmed(raw.reason) ? { reason: trimmed(raw.reason) } : {}),
    ...(trimmed(raw.nextAction) ? { nextAction: trimmed(raw.nextAction) } : {}),
    ...(trimmed(raw.evidence) ? { evidence: trimmed(raw.evidence) } : {}),
  };
}

function submissionToDecision(submission: MissionOwnerDecisionSubmission): ExtractedMissionOwnerDecision {
  const decision: ExtractedMissionOwnerDecision = { decision: submission.decision };
  if (submission.sourceIssueRef) decision.sourceIssueRef = submission.sourceIssueRef;
  if (submission.reworkTargetRef) decision.reworkTargetRef = submission.reworkTargetRef;
  if (submission.reason) decision.reason = submission.reason;
  if (submission.nextAction) decision.nextAction = submission.nextAction;
  if (submission.evidence) decision.evidence = submission.evidence;
  return decision;
}

function decisionPayloadFingerprint(submission: MissionOwnerDecisionSubmission): string {
  return createHash("sha256").update(JSON.stringify([
    submission.decision,
    submission.sourceIssueRef ?? null,
    submission.reworkTargetRef ?? null,
    submission.reason ?? null,
    submission.nextAction ?? null,
    submission.evidence ?? null,
  ])).digest("hex").slice(0, 24);
}

export function buildMissionOwnerDecisionIdempotencyKey(input: {
  readonly companyId: string;
  readonly ownerActionIssueId: string;
  readonly sourceIssueId: string | null;
  readonly submission: MissionOwnerDecisionSubmission;
  readonly heartbeatRunId?: string | null;
}): string {
  const runSegment = typeof input.heartbeatRunId === "string" && input.heartbeatRunId
    ? `run:${input.heartbeatRunId}`
    : "run:none";
  return `mission-owner-decision:${input.companyId}:${input.ownerActionIssueId}:${input.sourceIssueId ?? "no-source"}:${runSegment}:payload:${decisionPayloadFingerprint(input.submission)}`;
}

export type RecordedMissionOwnerDecision = {
  readonly eventId: string;
  readonly createdAt: Date;
  readonly submission: MissionOwnerDecisionSubmission;
};

export async function recordMissionOwnerDecision(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly issue: OwnerActionIssue;
  readonly submission: MissionOwnerDecisionSubmission;
  readonly sourceIssueId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly commentId?: string | null;
}): Promise<RecordedMissionOwnerDecision> {
  const sourceIssueId = input.sourceIssueId ?? null;
  const payload = {
    kind: MISSION_OWNER_DECISION_EVENT_TYPE,
    source: MISSION_OWNER_DECISION_SOURCE,
    ownerActionIssueId: input.issue.id,
    sourceIssueId,
    commentId: input.commentId ?? null,
    decision: input.submission.decision,
    ...(input.submission.sourceIssueRef ? { sourceIssueRef: input.submission.sourceIssueRef } : {}),
    ...(input.submission.reworkTargetRef ? { reworkTargetRef: input.submission.reworkTargetRef } : {}),
    ...(input.submission.reason ? { reason: input.submission.reason } : {}),
    ...(input.submission.nextAction ? { nextAction: input.submission.nextAction } : {}),
    ...(input.submission.evidence ? { evidence: input.submission.evidence } : {}),
  };
  const idempotencyKey = buildMissionOwnerDecisionIdempotencyKey({
    companyId: input.issue.companyId,
    ownerActionIssueId: input.issue.id,
    sourceIssueId,
    submission: input.submission,
    heartbeatRunId: input.heartbeatRunId,
  });
  const inserted = await input.db.insert(workflowTransitionEvents).values({
    companyId: input.issue.companyId,
    missionId: input.issue.missionId ?? null,
    issueId: input.issue.id,
    heartbeatRunId: input.heartbeatRunId ?? null,
    eventType: MISSION_OWNER_DECISION_EVENT_TYPE,
    layer: MISSION_OWNER_RECOVERY_LAYER,
    decision: input.submission.decision,
    // [immutable marker] user free-text reason 은 payload 에만; row.reason/reasonCode 는 고정 source.
    reason: MISSION_OWNER_DECISION_SOURCE,
    reasonCode: MISSION_OWNER_DECISION_SOURCE,
    idempotencyKey,
    payload,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt });

  // [exact event identity] 동일 run idempotency 충돌 시 insert 가 no-op 이면 같은 (company, idempotencyKey)
  //   row 를 안전하게 load 하여 authoritative eventId 를 반환한다.
  if (inserted.length > 0) {
    const row = inserted[0]!;
    return { eventId: row.id, createdAt: row.createdAt, submission: input.submission };
  }
  const [existing] = await input.db
    .select({ id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.issue.companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
      eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
      eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
      eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
      eq(workflowTransitionEvents.issueId, input.issue.id),
    ))
    .limit(1);
  if (!existing) {
    throw new Error("mission-owner-recovery-ledger: failed to resolve authoritative decision event after insert");
  }
  return { eventId: existing.id, createdAt: existing.createdAt, submission: input.submission };
}

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
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // [payload integrity] payload 의 kind/source/ownerActionIssueId 가 row 와 정확히 일치해야 권위.
    if (payload.kind !== MISSION_OWNER_DECISION_EVENT_TYPE) continue;
    if (payload.source !== MISSION_OWNER_DECISION_SOURCE) continue;
    if (!row.issueId || payload.ownerActionIssueId !== row.issueId) continue;
    const submission = normalizeSubmission({
      decision: typeof payload.decision === "string" ? payload.decision : "",
      sourceIssueRef: typeof payload.sourceIssueRef === "string" ? payload.sourceIssueRef : null,
      reworkTargetRef: typeof payload.reworkTargetRef === "string" ? payload.reworkTargetRef : null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      nextAction: typeof payload.nextAction === "string" ? payload.nextAction : null,
      evidence: typeof payload.evidence === "string" ? payload.evidence : null,
    });
    if (!submission) continue;
    if (!row.agentId) continue;
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
    sourceIssueRef: typeof payload.sourceIssueRef === "string" ? payload.sourceIssueRef : null,
    reworkTargetRef: typeof payload.reworkTargetRef === "string" ? payload.reworkTargetRef : null,
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

export { normalizeSubmission as parseMissionOwnerDecisionPayload };
