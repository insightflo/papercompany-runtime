// server/src/services/missions/recovery-ownership-guard.ts
//
// QA recovery ownership 게이트(req 1/2). oversight 가 source/producer 실패에 개입하기 전에
// 해당 실패를 QA recovery chain 이 소유 중인지 판정. read-only — 상태변경은 호출측이 원자적 수행.
//
// 판정 로직은 classifyRecoveryOwnership(pure)에, DB 쿼리는 resolveRecoveryOwnership 에 분리.
// qaRecoveryActive = recovery-chain OR(unblock 선행조건 아님 — wakeup/heartbeat 만으로 충분):
//   (a) live recovery wakeup(queued/claimed, chain issueId 또는 payload sourceIssueId/issueId) ∨
//   (b) queued/running recovery heartbeat(chain issue) ∨
//   (c) origin QA gate 연결 recovery unblock issue(non-terminal).
// 하나라도 참 → observe-only. unblock non-terminal + live 없음 = stalled(deadlock).
// unblock terminal 도 current-generation 공식 workflow_validation_verdict(PASS/REQUEST_CHANGES)가 있어야
// handoff; verdict 없는 terminal/stalled = deadlock(producer reopen ❌).
// consumer: supervision.ts · validation-gate-requeue.ts · heartbeat.ts(P4).

import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import { isQaLikeStep } from "./supervision-helpers.js";

export const RECOVERY_WAKEUP_STATUSES = ["queued", "claimed"] as const;
export const RECOVERY_HEARTBEAT_STATUSES = ["queued", "running"] as const;
export const TERMINAL_HANDOFF_VERDICTS = ["pass", "request_changes"] as const;

// recovery chain wakeup reason 리터럴. P6 에서 requestKind 컬럼으로 대체 시 제거(Risk 7).
export const RECOVERY_WAKEUP_REASONS = [
  "mission_validation_request_changes",
  "mission_owner_retry_source_issue",
  "mission_owner_decision_retry_source_issue",
] as const;

export const RECOVERY_UNBLOCK_ORIGIN_KIND = "mission_main_executor_unblock";

export type RecoveryOwnershipSignal = "live_wakeup" | "live_heartbeat" | "active_unblock";

export type RecoveryOwnershipVerdict =
  | {
      kind: "qa_recovery_live";
      signal: RecoveryOwnershipSignal;
      unblockIssueId?: string;
      heartbeatRunId?: string;
      wakeupRequestId?: string;
    }
  | {
      kind: "qa_recovery_stalled";
      unblockIssueId?: string;
      reason: string;
    }
  | {
      kind: "oversight_may_act";
      reason: "no_recovery_chain" | "terminal_handoff_complete";
    };

export interface RecoveryOwnershipInput {
  companyId: string;
  missionId: string;
  sourceIssueId: string;
  qaGateIssueId?: string | null;
  /** producer 현재 반복 완료 시각(current generation proof). terminal handoff verdict 의 신선도 기준. */
  producerCompletedAt?: Date | null;
}

/** pure 판정 입력 — DB 쿼리 결과를 boolean 으로 정규화하여 주입. classifyRecoveryOwnership 이 소비. */
export interface RecoveryOwnershipClassification {
  hasUnblock: boolean;
  unblockTerminal: boolean;
  hasLiveWakeup: boolean;
  hasLiveHeartbeat: boolean;
  hasCurrentGenVerdict: boolean;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

// pure 판정. DB 없음 — 단위 테스트 대상. 분기 순서가 OR 신호의 안전 의미를 결정.
export function classifyRecoveryOwnership(c: RecoveryOwnershipClassification): RecoveryOwnershipVerdict {
  // (b) live recovery heartbeat → observe-only(unblock 유무 무관).
  if (c.hasLiveHeartbeat) {
    return { kind: "qa_recovery_live", signal: "live_heartbeat" };
  }
  // (a) live recovery wakeup → observe-only(unblock 유무 무관).
  if (c.hasLiveWakeup) {
    return { kind: "qa_recovery_live", signal: "live_wakeup" };
  }
  // live work 없음.
  if (!c.hasUnblock) {
    return { kind: "oversight_may_act", reason: "no_recovery_chain" };
  }
  // (c) unblock non-terminal → chain 살았으나 실행 없음 → deadlock 정리(producer reopen ❌).
  if (!c.unblockTerminal) {
    return { kind: "qa_recovery_stalled", reason: "recovery_chain_active_no_live_work" };
  }
  // unblock terminal — current-generation 공식 verdict 있어야 handoff. 없으면 deadlock.
  if (c.hasCurrentGenVerdict) {
    return { kind: "oversight_may_act", reason: "terminal_handoff_complete" };
  }
  return { kind: "qa_recovery_stalled", reason: "terminal_recovery_without_generation_verdict" };
}

// wakeup 의 chain 소속 판정: issueId 가 chain 이거나 payload.sourceIssueId / payload.issueId 가 chain.
function wakeupChainScope(chainIssueIds: string[]) {
  const payloadMatches = chainIssueIds.flatMap((id) => [
    sql`${agentWakeupRequests.payload} ->> 'sourceIssueId' = ${id}`,
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${id}`,
  ]);
  return or(inArray(agentWakeupRequests.issueId, chainIssueIds), ...payloadMatches);
}

// source/producer issue 에 대한 QA recovery ownership 판정. DB 쿼리 → classifyRecoveryOwnership → ID 주입.
export async function resolveRecoveryOwnership(
  db: Db,
  input: RecoveryOwnershipInput,
): Promise<RecoveryOwnershipVerdict> {
  const chainOriginIds = uniqueIds([input.sourceIssueId, input.qaGateIssueId]);
  if (chainOriginIds.length === 0) {
    return { kind: "oversight_may_act", reason: "no_recovery_chain" };
  }

  const unblock = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.originKind, RECOVERY_UNBLOCK_ORIGIN_KIND),
      inArray(issues.originId, chainOriginIds),
      isNull(issues.hiddenAt),
    ))
    .orderBy(
      sql`CASE WHEN ${issues.status} IN ('done', 'cancelled') THEN 1 ELSE 0 END`,
      desc(issues.createdAt),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const chainIssueIds = uniqueIds([input.sourceIssueId, input.qaGateIssueId, unblock?.id]);

  const liveWakeup = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      inArray(agentWakeupRequests.status, [...RECOVERY_WAKEUP_STATUSES]),
      inArray(agentWakeupRequests.reason, [...RECOVERY_WAKEUP_REASONS]),
      wakeupChainScope(chainIssueIds),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const liveHeartbeat = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, [...RECOVERY_HEARTBEAT_STATUSES]),
      inArray(heartbeatRuns.issueId, chainIssueIds),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // handoff verdict 는 QA gate issue 에서 기록된 것만 인정(source issue verdict 는 unrelated).
  const gateIssueIds = uniqueIds([input.qaGateIssueId]);
  const hasCurrentGenVerdict = unblock && isTerminalIssueStatus(unblock.status) && gateIssueIds.length > 0
    ? await currentGenerationValidationVerdict(db, input.companyId, gateIssueIds, input.producerCompletedAt)
    : false;

  const verdict = classifyRecoveryOwnership({
    hasUnblock: Boolean(unblock),
    unblockTerminal: Boolean(unblock && isTerminalIssueStatus(unblock.status)),
    hasLiveWakeup: Boolean(liveWakeup),
    hasLiveHeartbeat: Boolean(liveHeartbeat),
    hasCurrentGenVerdict,
  });

  if (verdict.kind === "qa_recovery_live") {
    return { ...verdict, unblockIssueId: unblock?.id, heartbeatRunId: liveHeartbeat?.id, wakeupRequestId: liveWakeup?.id };
  }
  if (verdict.kind === "qa_recovery_stalled") {
    return { ...verdict, unblockIssueId: unblock?.id };
  }
  return verdict;
}

// chain QA gate(source/origin) 의 current-generation 공식 verdict(PASS/REQUEST_CHANGES).
async function currentGenerationValidationVerdict(
  db: Db,
  companyId: string,
  chainOriginIds: string[],
  producerCompletedAt: Date | null | undefined,
): Promise<boolean> {
  const row = await db
    .select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      inArray(workflowTransitionEvents.verdict, [...TERMINAL_HANDOFF_VERDICTS]),
      inArray(workflowTransitionEvents.issueId, chainOriginIds),
      ...(producerCompletedAt ? [gte(workflowTransitionEvents.createdAt, producerCompletedAt)] : []),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

export function isQaRecoveryLive(
  verdict: RecoveryOwnershipVerdict,
): verdict is Extract<RecoveryOwnershipVerdict, { kind: "qa_recovery_live" }> {
  return verdict.kind === "qa_recovery_live";
}

export function isQaRecoveryStalled(
  verdict: RecoveryOwnershipVerdict,
): verdict is Extract<RecoveryOwnershipVerdict, { kind: "qa_recovery_stalled" }> {
  return verdict.kind === "qa_recovery_stalled";
}

export function mayOversightAct(
  verdict: RecoveryOwnershipVerdict,
): verdict is Extract<RecoveryOwnershipVerdict, { kind: "oversight_may_act" }> {
  return verdict.kind === "oversight_may_act";
}

/** stale oversight wakeup consume-side no-op 판정(req 2). twin reason 만 검사. */
const OVERSIGHT_RETRY_REASONS = new Set(["mission_owner_retry_source_issue", "mission_owner_decision_retry_source_issue"]);

function readPayloadSourceIssueId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const v = rec.sourceIssueId ?? rec.issueId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

// issue 가 workflow QA gate step 인지(step definition 기반 isQaLikeStep) 확인.
async function isIssueQaGateStep(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const row = await db
    .select({ stepId: workflowStepRuns.stepId, stepsJson: workflowDefinitions.stepsJson })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowStepRuns.issueId, issueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return false;
  const steps = row.stepsJson as Parameters<typeof isQaLikeStep>[0][] | null;
  const step = Array.isArray(steps) ? steps.find((s) => (s as { id?: string }).id === (row.stepId ?? "")) : null;
  return Boolean(step && isQaLikeStep(step));
}

// promote 시 호출. mission_owner_retry_source_issue(twin) wakeup 이고 source 의 QA recovery 가
// live/stalled 면 noOp(guard 이전 큐 stale wakeup / race 회수). 다른 reason 는 그대로 진행.
// ownerActionIssueId → owner action origin 이 실제 QA step(isQaLikeStep)일 때만 guard 적용 —
// 일반 owner retry 는 noOp=false 로 오인 방지(codex P4 blocker).
export async function shouldNoOpOversightWakeup(
  db: Db,
  ctx: {
    companyId: string;
    missionId: string;
    request: { id: string; reason: string | null; payload?: unknown };
    promotedIssue: { id: string; status: string };
  },
): Promise<{ noOp: true; reason: string; ownerActionIssueId?: string; qaSignal: string } | { noOp: false }> {
  if (!ctx.request.reason || !OVERSIGHT_RETRY_REASONS.has(ctx.request.reason)) {
    return { noOp: false };
  }
  const ownerActionIssueId = readPayloadField(ctx.request.payload, "ownerActionIssueId");
  // ownerActionIssueId 없거나 owner action 이 unblock 이 아니면 안전하게 guard 미적용(malformed payload 방지, codex 재검토).
  if (!ownerActionIssueId) return { noOp: false };
  const ownerAction = await db
    .select({ originId: issues.originId, originKind: issues.originKind })
    .from(issues)
    .where(and(eq(issues.companyId, ctx.companyId), eq(issues.id, ownerActionIssueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!ownerAction || ownerAction.originKind !== "mission_main_executor_unblock" || !ownerAction.originId) {
    return { noOp: false };
  }
  // origin 이 실제 workflow QA step 인지 확인 — 아니면 guard 미적용(일반 owner retry 오인 방지).
  const originIsQaGate = await isIssueQaGateStep(db, ctx.companyId, ownerAction.originId);
  if (!originIsQaGate) return { noOp: false };
  const sourceIssueId = ownerAction.originId;
  const qaGateIssueId = ownerAction.originId;
  const ownership = await resolveRecoveryOwnership(db, {
    companyId: ctx.companyId,
    missionId: ctx.missionId,
    sourceIssueId,
    qaGateIssueId,
  });
  if (isQaRecoveryLive(ownership)) {
    return { noOp: true, reason: `qa_recovery_live signal=${ownership.signal}`, ownerActionIssueId: ownerActionIssueId ?? undefined, qaSignal: ownership.signal };
  }
  if (isQaRecoveryStalled(ownership)) {
    return { noOp: true, reason: `qa_recovery_stalled reason=${ownership.reason}`, ownerActionIssueId: ownerActionIssueId ?? undefined, qaSignal: ownership.reason };
  }
  return { noOp: false };
}

function readPayloadField(payload: unknown, field: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}
