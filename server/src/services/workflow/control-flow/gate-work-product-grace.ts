// server/src/services/workflow/control-flow/gate-work-product-grace.ts
//
// [purpose] 게이트 워크프로덕트 대기창(grace window). IF 게이트 평가 시 조상(producer)
//   스텝의 워크프로덕트 해소 실패가 "조상 스텝이 최근에 완료됐다"는 조건을 만족하면
//   즉시 실패 대신 pending-wait 로 돌려 다음 평가 패스에서 재조회한다. 대기창이 지나면
//   정직하게 실패한다(fail-closed 유지).
// [재평가 경로] (1) sync/heartbeat/resume 이 executeWorkflowRun 을 다시 돌릴 때,
//   (2) native reconciler 타이머(기본 5분)가 만료된 controlNodeGraceWait 를 재평가할 때.
// [safety] 과거 verdict 소급 변경 없음(completed 노드 미건드림). tool_json 소스는 라이브
//   실측이라 대기 대상 아님(WorkProductConditionWaitableError 는 work_product_json 경로에서만
//   발생). status 필드는 표시/결과 상태일 뿐 실행 증명이 아니다 — 대기 판정은 오직
//   workflowStepRuns.completedAt(기계 기록) 기반이다.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowStepRuns } from "@paperclipai/db";

const DEFAULT_GRACE_MINUTES = 10;
const DEFAULT_RETRY_SECONDS = 30;

function readPositiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Grace window in minutes. 0 disables the grace wait (legacy fail-fast). */
export function getGateWorkProductGraceMinutes(): number {
  const envMinutes = readPositiveIntEnv("WORKFLOW_GATE_WORK_PRODUCT_GRACE_MINUTES");
  if (envMinutes !== null) return Math.min(envMinutes, 1440);
  return DEFAULT_GRACE_MINUTES;
}

/** Delay (seconds, min 1) before a grace-waiting IF node becomes re-evaluable. */
export function getGateWorkProductGraceRetrySeconds(): number {
  const envSeconds = readPositiveIntEnv("WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS");
  if (envSeconds !== null) return Math.max(1, Math.min(Math.round(envSeconds), 3600));
  return DEFAULT_RETRY_SECONDS;
}

export type ControlNodeGraceWait = {
  reason: string;
  since: string;
  attempts: number;
  nextEvaluateAt: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function readControlNodeGraceWait(metadata: unknown): ControlNodeGraceWait | null {
  const raw = asRecord(metadata).controlNodeGraceWait;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const since = typeof record.since === "string" ? record.since : "";
  const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts)
    ? record.attempts
    : 0;
  const nextEvaluateAt = typeof record.nextEvaluateAt === "string" ? record.nextEvaluateAt : "";
  if (!since || !nextEvaluateAt) return null;
  return { reason, since, attempts, nextEvaluateAt };
}

/**
 * True while a grace-waiting control node must not be re-claimed by the
 * synchronous launch loop (prevents spin). Once nextEvaluateAt passes, the
 * step is runnable again and the next engine pass re-evaluates it honestly.
 */
export function isControlNodeGraceWaitBlockingDispatch(metadata: unknown, now: Date): boolean {
  const wait = readControlNodeGraceWait(metadata);
  if (!wait) return false;
  const nextMs = Date.parse(wait.nextEvaluateAt);
  if (!Number.isFinite(nextMs)) return false;
  // `<=` : release pass 자신의 재실행도 차단해 동일 패스 내 스핀을 막는다(retry 0 포함).
  return now.getTime() <= nextMs;
}

/**
 * Decides whether a waitable IF-condition failure qualifies for the grace wait:
 * the failing condition's producer (ancestor) step must have a completed
 * workflow step run in this run whose completedAt is within the grace window.
 * Outside the window the caller must fail honestly.
 */
export async function qualifiesForGateWorkProductGrace(input: {
  db: Db;
  workflowRunId: string;
  sourceStepId: string;
  now: Date;
  graceMinutes?: number;
}): Promise<boolean> {
  const graceMinutes = input.graceMinutes ?? getGateWorkProductGraceMinutes();
  if (graceMinutes <= 0) return false;

  // 완료 시점 근거: 이슈 completedAt(기계 기록, 불변). workflowStepRuns.completedAt 은
  // sync 패스마다 restamp 될 수 있어 대기창 근거로 부적합하다(라이브 실측 교정).
  const rows = await input.db
    .select({
      stepRunCompletedAt: workflowStepRuns.completedAt,
      issueCompletedAt: issues.completedAt,
    })
    .from(workflowStepRuns)
    .leftJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.stepId, input.sourceStepId),
      eq(workflowStepRuns.status, "completed"),
    ))
    .orderBy(desc(issues.completedAt))
    .limit(1);
  const completedAt = rows[0]?.issueCompletedAt ?? rows[0]?.stepRunCompletedAt;
  if (!completedAt) return false;
  return input.now.getTime() - completedAt.getTime() <= graceMinutes * 60_000;
}
