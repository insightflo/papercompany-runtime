// server/src/services/shutdown-flush.ts
//
// [checkpoint+graceful shutdown] 종료 플러시의 비(非)클로저 부분 — 체크포인트 참조 레코드 조립/검증과
// 데드라인 계산. 런 마킹+재시도 대기열 본체는 heartbeatService.markRunsShutdownInterrupted
// (heartbeat.ts) 에 있다 — enqueueProcessLossRetry/enqueueAdapterFallbackRun 클로저 재사용을 위해.
//
// 설계 계약(doc/plans/2026-09-27-checkpoint-shutdown.md):
//   - 마킹은 #277 CAS(setHeartbeatRunStatus expectedStatuses=["running"]) 경유 — 늙은 프로세스의
//     flush 가 새 런타임 상태를 덮어쓰지 않는다(split-brain 방지).
//   - 재시도 의미론은 process_lost 와 동일 정합(정확히 1회, processLossRetryCount 소진 규칙 동일).
//   - 미마킹 런은 running 유지 → 기존 reaper 가 회수(안전 장전).
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { effectIntents, heartbeatRuns, issues } from "@paperclipai/db";
import { shutdownCheckpointSchema, type ShutdownCheckpoint } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const SHUTDOWN_INTERRUPTED_ERROR_CODE = "shutdown_interrupted";

export type ShutdownFlushInput = {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  signal: "SIGINT" | "SIGTERM";
  lastPid: number | null;
  retryPlanned: boolean;
  interruptedAt: Date;
};

type CheckpointResult = { ok: true; checkpoint: ShutdownCheckpoint } | { ok: false; issues: string[] };

function readContextString(context: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = context?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 체크포인트 "참조 레코드" 조립 — 재개 상태의 원본은 각 내구 저장소(커서/envelope/세션)에 있고
 * 여기서는 참조만 모은다. zod v1 strict 로 검증되며 불량은 첨부 거부(마킹 자체는 계속 진행).
 */
export async function buildShutdownCheckpoint(input: ShutdownFlushInput): Promise<CheckpointResult> {
  const { db, run, signal, lastPid, retryPlanned, interruptedAt } = input;
  const context = run.contextSnapshot ?? null;

  // 참조 3: 이 런이 발행한 효과 intent 키 (#279 장부 — 상태 원본은 effect_intents).
  let effectIntentIds: string[] = [];
  try {
    const rows = await db
      .select({ effectId: effectIntents.effectId })
      .from(effectIntents)
      .where(eq(effectIntents.attemptRunId, run.id))
      .orderBy(desc(effectIntents.createdAt))
      .limit(50);
    effectIntentIds = rows.map((row) => row.effectId);
  } catch (err) {
    logger.warn({ err, runId: run.id }, "shutdown checkpoint: effect intent lookup failed; attaching empty list");
  }

  // 참조 2: 이슈 지시 소비 커서 (#276). issueId 열 우선, 없으면 contextSnapshot 보조
  // (enqueueProcessLossRetry 의 issueId 해석과 동일 규칙).
  const issueId = run.issueId ?? readContextString(context, "issueId");
  let issueInstructionCursor: ShutdownCheckpoint["issueInstructionCursor"] = null;
  if (issueId) {
    try {
      const [issue] = await db
        .select({
          lastCommentId: issues.lastOperatorInstructionCommentId,
          lastAt: issues.lastOperatorInstructionAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      if (issue) {
        issueInstructionCursor = {
          commentId: issue.lastCommentId ?? null,
          at: issue.lastAt ? new Date(issue.lastAt).toISOString() : null,
        };
      }
    } catch (err) {
      logger.warn({ err, runId: run.id, issueId }, "shutdown checkpoint: instruction cursor lookup failed");
    }
  }

  const candidate = {
    version: 1 as const,
    phase: "running_at_shutdown" as const,
    cause: "graceful_shutdown" as const,
    signal,
    interruptedAt: interruptedAt.toISOString(),
    lastPid,
    sessionId: run.sessionIdBefore ?? readContextString(context, "sessionId"),
    resumeToken: readContextString(context, "sessionResumeToken"),
    issueInstructionCursor,
    effectIntentIds,
    retryPlanned,
  };

  const parsed = shutdownCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  return { ok: true, checkpoint: parsed.data };
}

export function remainingMs(deadlineAt: number): number {
  return deadlineAt - Date.now();
}

export type ShutdownFlushSummary = {
  considered: number;
  marked: number;
  fenced: number;
  retried: number;
  fallbackQueued: number;
  released: number;
  skippedDeadline: number;
  errors: number;
  deadlineExceeded: boolean;
};

export function emptyFlushSummary(): ShutdownFlushSummary {
  return {
    considered: 0,
    marked: 0,
    fenced: 0,
    retried: 0,
    fallbackQueued: 0,
    released: 0,
    skippedDeadline: 0,
    errors: 0,
    deadlineExceeded: false,
  };
}
