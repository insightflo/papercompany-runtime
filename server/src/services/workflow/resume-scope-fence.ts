import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";

/**
 * [파일 목적] Task6c stale-generation result fence — resume run 의 결과 기록자(tool result,
 *   heartbeat settlement, issue closeout, agent artifact 등록)가 현재 세대에만 쓰도록 하는
 *   범위(scope) 검증 헬퍼. ordinary run 은 검증 자체를 통과시켜 기존 동작과 byte-identical.
 * [stamp 규약] resumeRequestId 는 workflow_runs.metadata 와 workflow_step_runs.metadata 의
 *   own non-null string key 로만 판정한다(resume/reset.ts 가 stamp 한다; prototype key 불가).
 * [불변식] generation 은 resetForResume 이 resumeRequestId stamp 과 같은 트랜잭션에서 +1 한다.
 *   따라서 step stamp === run stamp 이고 recorded generation === 현재 generation 이면 그 결과는
 *   현재 resume 세대의 것이다. 불일치면 결과는 이전 세대의 늦은 도착물 — 무음 스킵 또는
 *   아래의 진단 로그 1건만 기록한다. 진단 로그는 표시/감사 전용이며 실행 권위로 파싱되지
 *   않는다(AGENTS.md 규칙 8).
 */

export type ResumeScopeDb = Pick<Db, "select">;
export type ResumeScopeInsertDb = Pick<Db, "insert">;

export function readOwnResumeRequestId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (!Object.hasOwn(record, "resumeRequestId")) return null;
  const value = record.resumeRequestId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type ResumeScopeVerdict =
  | { action: "allow" }
  | {
    action: "reject";
    workflowRunId: string | null;
    workflowStepRunId: string | null;
    gotGeneration: number | null;
    wantGeneration: number | null;
    reason: "generation_mismatch" | "resume_request_id_mismatch";
  };

export type HeartbeatResumeScopeRun = {
  companyId: string;
  workflowStepRunId?: string | null;
  workflowExecutionGeneration?: number | null;
  wakeupRequestId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

function readContextStepRunId(contextSnapshot: Record<string, unknown> | null | undefined): string | null {
  const value = contextSnapshot?.workflowStepRunId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readValidGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** acting heartbeat 의 typed 세대 우선; 없을 때만 정확히 같은 run/step 의 wakeup 을 읽는다. */
async function readRecordedGeneration(
  db: ResumeScopeDb,
  run: HeartbeatResumeScopeRun,
  workflowRunId: string,
  workflowStepRunId: string,
): Promise<number | null> {
  if (run.workflowExecutionGeneration != null) return readValidGeneration(run.workflowExecutionGeneration);
  if (!run.wakeupRequestId) return null;
  const wakeup = await db
    .select({ generation: agentWakeupRequests.workflowExecutionGeneration })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId),
      eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.workflowRunId, workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, workflowStepRunId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return readValidGeneration(wakeup?.generation);
}

/**
 * settlement 게이트: acting heartbeat run 이 알던 링크(stepRunId, generation)가 현재 행과
 * 정확히 일치하는지 검증한다. step 이 resume stamp 가 없으면 ordinary run — 허용(무검증).
 */
export async function resolveHeartbeatResumeScopeFence(
  db: ResumeScopeDb,
  run: HeartbeatResumeScopeRun,
): Promise<ResumeScopeVerdict> {
  const stepRunId = run.workflowStepRunId ?? readContextStepRunId(run.contextSnapshot);
  if (!stepRunId) return { action: "allow" };
  const row = await db
    .select({
      workflowRunId: workflowStepRuns.workflowRunId,
      executionGeneration: workflowStepRuns.executionGeneration,
      stepMetadata: workflowStepRuns.metadata,
      runMetadata: workflowRuns.metadata,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, stepRunId), eq(workflowRuns.companyId, run.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  // 링크 대상 행이 없으면 fence 가 새로운 실패를 만들지 않는다(기존 settlement 동작 유지).
  if (!row) return { action: "allow" };
  const stepStamp = readOwnResumeRequestId(row.stepMetadata);
  if (stepStamp === null) return { action: "allow" };
  const runStamp = readOwnResumeRequestId(row.runMetadata);
  if (runStamp !== stepStamp) {
    return {
      action: "reject",
      workflowRunId: row.workflowRunId,
      workflowStepRunId: stepRunId,
      gotGeneration: row.executionGeneration,
      wantGeneration: row.executionGeneration,
      reason: "resume_request_id_mismatch",
    };
  }
  const wantGeneration = await readRecordedGeneration(db, run, row.workflowRunId, stepRunId);
  if (wantGeneration === null || wantGeneration !== row.executionGeneration) {
    return {
      action: "reject",
      workflowRunId: row.workflowRunId,
      workflowStepRunId: stepRunId,
      gotGeneration: row.executionGeneration,
      wantGeneration,
      reason: "generation_mismatch",
    };
  }
  return { action: "allow" };
}

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

/**
 * issue 스코프 신원 검증: issue 에 link 된 active step run 이 resume run(run stamp 존재)이면,
 * 그 step 의 stamp 이 run 의 현재 stamp 과 일치해야만 true. ordinary issue 는 항상 true.
 * artifact 등록(contract D)과 heartbeat 자동등록 보조 경로(contract C-ii)가 공유한다.
 */
export async function assertIssueResumeScopeIdentity(
  db: ResumeScopeDb,
  input: { companyId: string; issueId: string },
): Promise<boolean> {
  const rows = await db
    .select({
      stepMetadata: workflowStepRuns.metadata,
      runMetadata: workflowRuns.metadata,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      eq(workflowStepRuns.issueId, input.issueId),
      eq(workflowRuns.companyId, input.companyId),
      ACTIVE_STEP_STATUS_CONDITION,
    ));
  for (const row of rows) {
    const runStamp = readOwnResumeRequestId(row.runMetadata);
    if (runStamp === null) continue; // ordinary run — fence 대상 아님
    if (readOwnResumeRequestId(row.stepMetadata) !== runStamp) return false;
  }
  return true;
}

/** stale 결과 기각의 구조화 진단 1건. 실행 권위로 읽히지 않는다(표시/감사 전용). */
export async function recordResumeStaleResultRejected(
  db: ResumeScopeInsertDb,
  input: {
    companyId: string;
    issueId: string;
    heartbeatRunId: string | null;
    agentId?: string | null;
    verdict: Extract<ResumeScopeVerdict, { action: "reject" }>;
    source?: string;
  },
): Promise<void> {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "workflow.resume_stale_result_rejected",
    entityType: "issue",
    entityId: input.issueId,
    agentId: input.agentId ?? null,
    runId: input.heartbeatRunId,
    details: {
      workflowRunId: input.verdict.workflowRunId,
      stepRunId: input.verdict.workflowStepRunId,
      gotGeneration: input.verdict.gotGeneration,
      wantGeneration: input.verdict.wantGeneration,
      reason: input.verdict.reason,
      ...(input.source ? { source: input.source } : {}),
    },
  });
}
