// recovery-ownership-guard.ts — QA recovery ownership 게이트(req 1/2). read-only.
// qaRecoveryActive = live QA wakeup(queued/claimed) OR live QA heartbeat(queued/running) (OR).
// 하나라도 → observe-only. live 없으면(deadlock/terminal/verdict 무관) oversight 기존 recovery 경로.
// consumer: supervision.ts · validation-gate-requeue.ts · heartbeat.ts(P4).

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { isQaLikeStep } from "./supervision-helpers.js";

export const RECOVERY_WAKEUP_STATUSES = ["queued", "claimed"] as const;
export const RECOVERY_HEARTBEAT_STATUSES = ["queued", "running"] as const;
export const RECOVERY_WAKEUP_REASONS = [
  "mission_validation_request_changes",
  "mission_owner_retry_source_issue",
  "mission_owner_decision_retry_source_issue",
] as const;
export const RECOVERY_UNBLOCK_ORIGIN_KIND = "mission_main_executor_unblock";
const OVERSIGHT_RETRY_REASONS = new Set(["mission_owner_retry_source_issue", "mission_owner_decision_retry_source_issue"]);

export type RecoveryOwnershipSignal = "live_wakeup" | "live_heartbeat";

export type RecoveryOwnershipVerdict =
  | { kind: "qa_recovery_live"; signal: RecoveryOwnershipSignal; unblockIssueId?: string; heartbeatRunId?: string; wakeupRequestId?: string }
  | { kind: "oversight_may_act"; reason: string };

export interface RecoveryOwnershipInput {
  companyId: string;
  missionId: string;
  sourceIssueId: string;
  qaGateIssueId?: string | null;
  /** live-wakeup 쿼리에서 제외할 request id(promote 중인 자기 자신 self-noop 방지, codex review). */
  excludeWakeupRequestId?: string | null;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

// pure 판정. live(heartbeat/wakeup)만 observe-only. 그 외는 oversight 진행.
export function classifyRecoveryOwnership(c: { hasLiveHeartbeat: boolean; hasLiveWakeup: boolean }): RecoveryOwnershipVerdict {
  if (c.hasLiveHeartbeat) return { kind: "qa_recovery_live", signal: "live_heartbeat" };
  if (c.hasLiveWakeup) return { kind: "qa_recovery_live", signal: "live_wakeup" };
  return { kind: "oversight_may_act", reason: "no_live_qa_recovery" };
}

function wakeupChainScope(chainIssueIds: string[]) {
  const payloadMatches = chainIssueIds.flatMap((id) => [
    sql`${agentWakeupRequests.payload} ->> 'sourceIssueId' = ${id}`,
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${id}`,
  ]);
  return or(inArray(agentWakeupRequests.issueId, chainIssueIds), ...payloadMatches);
}

export async function resolveRecoveryOwnership(db: Db, input: RecoveryOwnershipInput): Promise<RecoveryOwnershipVerdict> {
  const recoveryIssueIds = uniqueIds([input.sourceIssueId, input.qaGateIssueId]);
  if (recoveryIssueIds.length === 0) return { kind: "oversight_may_act", reason: "no_recovery_chain" };

  const liveHeartbeat = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, [...RECOVERY_HEARTBEAT_STATUSES]),
      inArray(heartbeatRuns.issueId, recoveryIssueIds),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const liveWakeup = liveHeartbeat ? null : await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      inArray(agentWakeupRequests.status, [...RECOVERY_WAKEUP_STATUSES]),
      inArray(agentWakeupRequests.reason, [...RECOVERY_WAKEUP_REASONS]),
      wakeupChainScope(recoveryIssueIds),
      ...(input.excludeWakeupRequestId ? [sql`${agentWakeupRequests.id} <> ${input.excludeWakeupRequestId}`] : []),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const verdict = classifyRecoveryOwnership({
    hasLiveHeartbeat: Boolean(liveHeartbeat),
    hasLiveWakeup: Boolean(liveWakeup),
  });
  if (verdict.kind === "qa_recovery_live") {
    return { ...verdict, heartbeatRunId: liveHeartbeat?.id, wakeupRequestId: liveWakeup?.id };
  }
  return verdict;
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

function readPayloadField(payload: unknown, field: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// promote 시 호출. twin reason wakeup 이 owner action origin QA chain live 면 noOp(race/stale 회수).
// ownerActionIssueId 없거나 originKind≠unblock 또는 origin 비-QA 면 noOp=false(일반 wakeup 보호).
export async function shouldNoOpOversightWakeup(
  db: Db,
  ctx: {
    companyId: string;
    missionId: string;
    request: { id: string; reason: string | null; payload?: unknown };
    promotedIssue: { id: string; status: string };
  },
): Promise<{ noOp: true; reason: string; ownerActionIssueId?: string; qaSignal: string } | { noOp: false }> {
  if (!ctx.request.reason || !OVERSIGHT_RETRY_REASONS.has(ctx.request.reason)) return { noOp: false };
  const ownerActionIssueId = readPayloadField(ctx.request.payload, "ownerActionIssueId");
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
  const originIsQaGate = await isIssueQaGateStep(db, ctx.companyId, ownerAction.originId);
  if (!originIsQaGate) return { noOp: false };
  const ownership = await resolveRecoveryOwnership(db, {
    companyId: ctx.companyId, missionId: ctx.missionId,
    sourceIssueId: ownerAction.originId, qaGateIssueId: ownerAction.originId,
    excludeWakeupRequestId: ctx.request.id,
  });
  if (ownership.kind === "qa_recovery_live") {
    return { noOp: true, reason: `qa_recovery_live signal=${ownership.signal}`, ownerActionIssueId, qaSignal: ownership.signal };
  }
  return { noOp: false };
}

export function isQaRecoveryLive(
  verdict: RecoveryOwnershipVerdict,
): verdict is Extract<RecoveryOwnershipVerdict, { kind: "qa_recovery_live" }> {
  return verdict.kind === "qa_recovery_live";
}
