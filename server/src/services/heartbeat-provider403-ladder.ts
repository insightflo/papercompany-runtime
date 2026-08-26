// server/src/services/heartbeat-provider403-ladder.ts
//
// [파일 목적] provider 403(auth/forbidden·quota) 계열 실패가 기존 자동 재시작 계기
//   (adapter_failed_transient 1회 재시도 → fallback run)까지 모두 소진되어 종단한 뒤,
//   일시적 provider 장애라면 유일한 회복 계기가 우연한 주기 wake가 되는 공백(2026-08-25
//   gazua-evening mission 50fc2476 run 64c1b0bf: ~45분 정체)을 메운다.
//
// [설계] 기존 agent_wakeup_requests 큐를 그대로 쓴다(스키마 컬럼 추가 없음, promote/claim
//   경로 무변경 — 실행통제 규칙 7 준수). 주기 reconciler tick이 이 모듈의 scan을 호출하고,
//   due 시점에 wakeup 1행을 삽입한다. 삽입된 wake는 표준 promotion으로 실제 run이 되고,
//   성공 시 기존 완료 경로가 그대로 이어받는다(특수 처리 없음).
//
// [분류 경계] 사다리 진입은 classifyHeartbeatRunFailure의 403 계열 reasonCode 2종
//   (PROVIDER_AUTH_OR_FORBIDDEN_403 / PROVIDER_QUOTA_OR_AUTH_403)뿐이다. 결정적 설정 실패
//   (400 param incorrect / unsupported model 등)와 비-403 인증 실패(invalid api key 등)는
//   애초에 이 reasonCode가 나오지 않으므로 구조적으로 제외된다(영구 misconfig가 3회 루프에
//   빠지지 않는다). env로 집합 교체 가능(PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES).
//
// [멱등/동시성] rung 키 = provider403-ladder:{issueId}:{stepToken}:{index}. 부분 유니크 인덱스
//   (0093) + onConflictDoNothing으로 스캐너 중복/경합 시 정확히 1행만 생긴다. 소비된 rung 행은
//   terminal 상태로 남아 카운트된다(재삽입 루프 방지). anchor 시각은 최초 rung payload의
//   anchorFinishedAt로 고정되어 이후 실패가 끼어도 간격이 흔들리지 않는다.
import { and, desc, eq, gt, gte, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues, missions } from "@paperclipai/db";
import { classifyHeartbeatRunFailure } from "./heartbeat.js";
import { DEFERRED_WAKE_CONTEXT_KEY } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import {
  resolveProvider403LadderReasonCodes,
  resolveProvider403RetryDelaysMin,
} from "./heartbeat-stability.js";
import { logger } from "../middleware/logger.js";

export const PROVIDER_403_LADDER_WAKEUP_REASON = "provider_403_retry";
const PROVIDER_403_LADDER_KEY_PREFIX = "provider403-ladder:";
const NON_RUNNABLE_AGENT_STATUSES = new Set(["terminated", "paused", "pending_approval"]);
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled", "canceled"]);
const CANDIDATE_SCAN_LIMIT = 500;
/** 마지막 rung 이후 여유 창(분). 앵커 판별 윈도우 상한으로 쓴다. */
const SCAN_WINDOW_SLACK_MIN = 60;

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type WakeupRow = typeof agentWakeupRequests.$inferSelect;

export interface Provider403LadderScanOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function snapshotOf(run: Pick<HeartbeatRunRow, "contextSnapshot">): Record<string, unknown> {
  return run.contextSnapshot && typeof run.contextSnapshot === "object" && !Array.isArray(run.contextSnapshot)
    ? run.contextSnapshot as Record<string, unknown>
    : {};
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function scopeKeyOf(issueId: string, ctx: Record<string, unknown>): string {
  const stepToken = readNonEmptyString(ctx.workflowStepId) ?? readNonEmptyString(ctx.stepId) ?? "issue";
  return `${issueId}:${stepToken}`;
}

/** 실패 run이 사다리 후보(일시 가능 403 계열)인지 판정하는 순수 함수. */
export function isProvider403LadderCandidateRun(input: {
  run: Pick<HeartbeatRunRow, "status" | "errorCode" | "error" | "stdoutExcerpt" | "stderrExcerpt" | "contextSnapshot">;
  reasonCodes: ReadonlySet<string>;
}): boolean {
  if (input.run.status !== "failed" || input.run.errorCode !== "adapter_failed") return false;
  const ctx = snapshotOf(input.run);
  // fallback 경로의 실패는 fallback 사다리(attempt cap) 소관 — 중복 사다리를 만들지 않는다.
  if (readNonEmptyString(ctx.fallbackOfRunId)) return false;
  const classification = classifyHeartbeatRunFailure({
    status: "failed",
    errorCode: input.run.errorCode,
    errorMessage: input.run.error,
    stdoutExcerpt: input.run.stdoutExcerpt,
    stderrExcerpt: input.run.stderrExcerpt,
  });
  return classification.reasonCode != null && input.reasonCodes.has(classification.reasonCode);
}

interface LadderGroup {
  companyId: string;
  agentId: string;
  issueId: string;
  stepToken: string;
  scope: string;
  workflowRunId: string | null;
  /** 윈도우 내 최신 qualifying 실패 시각 — 신규 에피소드 판정 기준. */
  latestFailureAt: Date;
  /** 윈도우 내 최초 qualifying 실패(run) — 기존 rung이 없을 때 anchor 후보. */
  firstFailure: HeartbeatRunRow;
}

function groupKey(companyId: string, scope: string): string {
  return `${companyId}:${scope}`;
}

/**
 * 종단 403 지점을 스캔해 due한 rung의 scheduled wakeup을 정확히 1행씩 만든다.
 * 반환 scheduled = 이번 호출에서 새로 삽입된 rung 수.
 */
export async function reconcileProvider403LadderWakeups(
  db: Db,
  opts?: Provider403LadderScanOptions,
): Promise<{ scheduled: number }> {
  const now = opts?.now ?? new Date();
  const env = opts?.env ?? process.env;
  const delaysMin = resolveProvider403RetryDelaysMin(env);
  const reasonCodes = new Set(resolveProvider403LadderReasonCodes(env));
  if (delaysMin.length === 0 || reasonCodes.size === 0) return { scheduled: 0 };

  const maxDelayMs = Math.max(...delaysMin) * 60_000;
  const cutoff = new Date(now.getTime() - maxDelayMs - SCAN_WINDOW_SLACK_MIN * 60_000);
  const candidates = await db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.status, "failed"),
      eq(heartbeatRuns.errorCode, "adapter_failed"),
      gte(heartbeatRuns.finishedAt, cutoff),
    ))
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(CANDIDATE_SCAN_LIMIT);
  const eligible = candidates.filter((run) => isProvider403LadderCandidateRun({ run, reasonCodes }));
  if (eligible.length === 0) return { scheduled: 0 };

  // desc 순서이므로 scope 첫 관측=최신 실패, 이후 관측으로 first(최초) 실패를 갱신.
  const groups = new Map<string, LadderGroup>();
  for (const run of eligible) {
    const ctx = snapshotOf(run);
    const issueId = run.issueId ?? readNonEmptyString(ctx.issueId);
    if (!issueId) continue;
    const scope = scopeKeyOf(issueId, ctx);
    const key = groupKey(run.companyId, scope);
    const finishedAt = run.finishedAt ?? run.createdAt;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        stepToken: scope.slice(issueId.length + 1),
        scope,
        workflowRunId: readNonEmptyString(ctx.workflowRunId),
        latestFailureAt: finishedAt,
        firstFailure: run,
      });
    } else {
      existing.latestFailureAt = finishedAt > existing.latestFailureAt ? finishedAt : existing.latestFailureAt;
      if (finishedAt < (existing.firstFailure.finishedAt ?? existing.firstFailure.createdAt)) {
        existing.firstFailure = run;
      }
    }
  }

  let scheduled = 0;
  for (const group of groups.values()) {
    const [issueRow] = await db
      .select({ status: issues.status, missionId: issues.missionId })
      .from(issues)
      .where(eq(issues.id, group.issueId))
      .limit(1);
    if (!issueRow || issueRow.status === "done" || issueRow.status === "cancelled") continue;
    const missionId = issueRow.missionId ?? null;
    if (missionId) {
      const [missionRow] = await db
        .select({ status: missions.status })
        .from(missions)
        .where(eq(missions.id, missionId))
        .limit(1);
      if (missionRow && TERMINAL_MISSION_STATUSES.has(missionRow.status)) continue;
    }
    const [agentRow] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, group.agentId))
      .limit(1);
    if (!agentRow || NON_RUNNABLE_AGENT_STATUSES.has(agentRow.status)) continue;
    // 최신 실패 이후 같은 issue의 succeeded run이 있으면 이미 회복됨 — 새 rung 금지.
    const [recovered] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, group.companyId),
        eq(heartbeatRuns.issueId, group.issueId),
        eq(heartbeatRuns.status, "succeeded"),
        gt(heartbeatRuns.finishedAt, group.latestFailureAt),
      ))
      .limit(1);
    if (recovered) continue;

    const existingRungs = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, group.companyId),
        like(agentWakeupRequests.idempotencyKey, `${PROVIDER_403_LADDER_KEY_PREFIX}${escapeLike(group.scope)}:%`),
      ));
    const attemptIndex = existingRungs.length;
    if (attemptIndex >= delaysMin.length) continue; // exhausted

    // anchor 고정: 기존 rung payload의 anchorFinishedAt, 없으면 윈도우 내 최초 실패 시각.
    let anchorAt = group.firstFailure.finishedAt ?? group.firstFailure.createdAt;
    let anchorRunId = group.firstFailure.id;
    for (const rung of existingRungs) {
      const iso = readNonEmptyString((rung.payload as Record<string, unknown> | null)?.anchorFinishedAt);
      if (!iso) continue;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime()) && parsed < anchorAt) {
        anchorAt = parsed;
      }
    }
    const delayMin = delaysMin[attemptIndex]!;
    const dueAt = new Date(anchorAt.getTime() + delayMin * 60_000);
    if (now < dueAt) continue;

    const idempotencyKey = `${PROVIDER_403_LADDER_KEY_PREFIX}${group.scope}:${attemptIndex}`;
    const ladderPayload = {
      schema: "provider403-ladder/v1",
      attempt: attemptIndex + 1,
      totalAttempts: delaysMin.length,
      delaysMin,
      issueId: group.issueId,
      workflowRunId: group.workflowRunId,
      anchorRunId,
      anchorFinishedAt: anchorAt.toISOString(),
    };
    const anchorCtx = snapshotOf(group.firstFailure);
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: group.companyId,
          agentId: group.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: PROVIDER_403_LADDER_WAKEUP_REASON,
          requestKind: PROVIDER_403_LADDER_WAKEUP_REASON,
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          idempotencyKey,
          issueId: group.issueId,
          missionId,
          workflowRunId: group.workflowRunId,
          workflowStepRunId: null,
          payload: {
            ...ladderPayload,
            // 표준 promotion이 이슈/미션 맥락을 보존하도록 deferred context 로 실은다.
            [DEFERRED_WAKE_CONTEXT_KEY]: {
              ...anchorCtx,
              issueId: group.issueId,
              ...(missionId ? { missionId } : {}),
              ...(group.workflowRunId ? { workflowRunId: group.workflowRunId } : {}),
              retryOfRunId: anchorRunId,
              wakeReason: PROVIDER_403_LADDER_WAKEUP_REASON,
              retryReason: "provider_403",
            },
          },
        })
        .onConflictDoNothing()
        .returning();
      return rows[0] ?? null;
    });
    if (!inserted) continue; // 다른 스캐너가 먼저 삽입(경합) — 멱등 스킵.
    scheduled += 1;
    try {
      await logActivity(db, {
        companyId: group.companyId,
        actorType: "system",
        actorId: "provider403-ladder",
        action: "heartbeat.provider_403_retry_scheduled",
        entityType: "issue",
        entityId: group.issueId,
        details: { ...ladderPayload, idempotencyKey, dueAt: dueAt.toISOString(), wakeupRequestId: inserted.id },
      });
    } catch (err) {
      logger.warn({ err, issueId: group.issueId }, "failed to log provider403 ladder scheduling activity");
    }
  }

  return { scheduled };
}

/** 종단 에스컬레이션용 요약: 미션 스코프에서 소진된 사다리 시도 수/간격(구조화 값). */
export async function summarizeProvider403LadderForMission(
  db: Db,
  companyId: string,
  missionId: string,
): Promise<{ attempts: number; delaysMin: number[] } | null> {
  const rows: WakeupRow[] = await db
    .select()
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.missionId, missionId),
      eq(agentWakeupRequests.requestKind, PROVIDER_403_LADDER_WAKEUP_REASON),
    ));
  if (rows.length === 0) return null;
  for (const row of rows) {
    const delays = (row.payload as Record<string, unknown> | null)?.delaysMin;
    if (Array.isArray(delays) && delays.every((value) => typeof value === "number")) {
      return { attempts: rows.length, delaysMin: delays as number[] };
    }
  }
  return { attempts: rows.length, delaysMin: resolveProvider403RetryDelaysMin() };
}
