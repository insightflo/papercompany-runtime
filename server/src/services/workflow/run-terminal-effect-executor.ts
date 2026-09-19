// server/src/services/workflow/run-terminal-effect-executor.ts
//
// [run-terminal-boundary v1] 종결 결정의 커밋 후 부작용 실행기(outbox 재처리).
// 인텐트는 권위가 아니라 실행할 사실이며, 실행기는 단일 인텐트 실패로 절대 죽지 않는다.
// 각 효과는 대상 상태를 실행 시점에 재검증한다(캡처 후 세상이 바뀌었을 수 있다).

import { and, eq, gte, inArray, isNull, lt, lte, notInArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
} from "@paperclipai/db";
import { issueService } from "../issues.js";
import { stopMissionRuntimesForMission } from "../missions/mission-runtime-manager.js";
import { sanitizeErrorSummary } from "./retry-metadata.js";

type TerminalEffectIntent = typeof workflowTerminalEffectIntents.$inferSelect;

interface EffectContext {
  companyId: string;
  missionId: string | null;
}

export interface TerminalEffectRunResult {
  executed: number;
  failed: number;
}

/** kill_runtime — stopMissionRuntimesForMission 이 id+company+mission+active 재검증을 수행한다(계약 B). */
async function executeKillRuntime(db: Db, intent: TerminalEffectIntent, ctx: EffectContext): Promise<void> {
  if (!ctx.missionId) throw new Error("kill_runtime intent has no mission scope");
  await stopMissionRuntimesForMission(db, {
    companyId: intent.companyId,
    missionId: ctx.missionId,
    reason: `terminal decision ${intent.terminalDecisionId}`,
    onlyRuntimeIds: [intent.targetId],
  });
}

/** cancel_heartbeat_run — bounded settlement 의 guard 형태를 단일 run 스코프로 축소 복제. */
async function executeCancelHeartbeatRun(db: Db, intent: TerminalEffectIntent, now: Date): Promise<void> {
  const error = `Cancelled because workflow run reached terminal decision ${intent.terminalDecisionId}`;
  const scope = and(
    eq(heartbeatRuns.companyId, intent.companyId),
    eq(heartbeatRuns.id, intent.targetId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  );
  const [active] = await db
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, wakeupRequestId: heartbeatRuns.wakeupRequestId })
    .from(heartbeatRuns)
    .where(scope);
  if (!active) {
    // 대상 행이 삭제되었으면 할 일이 없다. 행이 남아 있는데 비활성이면 캡처 후 세상이
    // 바뀐 것이므로 실패로 남겨 재처리/조사 대상이 된다.
    const [current] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, intent.companyId), eq(heartbeatRuns.id, intent.targetId)));
    if (!current) return;
    throw new Error("heartbeat run already settled before cancel effect");
  }
  const cancelled = await db
    .update(heartbeatRuns)
    .set({ status: "cancelled", finishedAt: now, error, errorCode: "cancelled", updatedAt: now })
    .where(scope)
    .returning({ id: heartbeatRuns.id });
  if (cancelled.length === 0) return;
  if (active.wakeupRequestId) {
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: now, error, updatedAt: now })
      .where(and(
        eq(agentWakeupRequests.id, active.wakeupRequestId),
        eq(agentWakeupRequests.companyId, intent.companyId),
        eq(agentWakeupRequests.agentId, active.agentId),
        or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, active.id)),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
      ));
  }
  // 실행 링크는 이 heartbeat run 에 묶인 것만 해제한다(미션 전체 스코프 금지).
  await db
    .update(issues)
    .set({ checkoutRunId: null, updatedAt: now })
    .where(and(eq(issues.companyId, intent.companyId), eq(issues.checkoutRunId, active.id)));
  await db
    .update(issues)
    .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
    .where(and(eq(issues.companyId, intent.companyId), eq(issues.executionRunId, active.id)));
}

/** supersede_unblock_issue — 비종결 보장 하에 취소로 대체하고 결정 출처 코멘트를 남긴다. */
async function executeSupersedeUnblockIssue(db: Db, intent: TerminalEffectIntent, now: Date): Promise<void> {
  const updated = await db
    .update(issues)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(and(
      eq(issues.companyId, intent.companyId),
      eq(issues.id, intent.targetId),
      notInArray(issues.status, ["done", "cancelled"]),
    ))
    .returning({ id: issues.id });
  if (updated.length === 0) return; // 이미 종결 = 바람직한 상태 — 멱등 no-op.
  await issueService(db).addComment(
    intent.targetId,
    `Superseded (cancelled) by workflow terminal decision ${intent.terminalDecisionId}: `
      + "this owner action no longer represents open mission work after the run was finalized.",
    {},
  );
}

/** 인텐트 1건 실행 + 시도 계장. 실패는 pending 유지(lastError 산출)이고 밖으로 throw 하지 않는다. */
async function runSingleEffectIntent(
  db: Db,
  intent: TerminalEffectIntent,
  ctx: EffectContext,
  now: Date,
): Promise<boolean> {
  try {
    if (intent.effectKind === "kill_runtime") {
      await executeKillRuntime(db, intent, ctx);
    } else if (intent.effectKind === "cancel_heartbeat_run") {
      await executeCancelHeartbeatRun(db, intent, now);
    } else if (intent.effectKind === "supersede_unblock_issue") {
      await executeSupersedeUnblockIssue(db, intent, now);
    } else {
      throw new Error(`unknown effect kind: ${intent.effectKind}`);
    }
    await db
      .update(workflowTerminalEffectIntents)
      .set({ status: "completed", completedAt: now, attemptCount: intent.attemptCount + 1 })
      .where(eq(workflowTerminalEffectIntents.id, intent.id));
    return true;
  } catch (error) {
    await db
      .update(workflowTerminalEffectIntents)
      .set({
        status: "pending",
        attemptCount: intent.attemptCount + 1,
        lastError: sanitizeErrorSummary(error instanceof Error ? error.message : String(error)),
      })
      .where(eq(workflowTerminalEffectIntents.id, intent.id));
    return false;
  }
}

/** 단일 결정의 pending 인텐트를 즉시 실행한다(커밋 직후 경로). */
export async function executeTerminalEffectIntents(
  db: Db,
  decisionId: string,
  now: Date = new Date(),
): Promise<TerminalEffectRunResult> {
  const [decision] = await db
    .select({
      companyId: workflowTerminalDecisions.companyId,
      missionId: workflowRuns.missionId,
    })
    .from(workflowTerminalDecisions)
    .innerJoin(workflowRuns, eq(workflowTerminalDecisions.workflowRunId, workflowRuns.id))
    .where(eq(workflowTerminalDecisions.id, decisionId));
  if (!decision) throw new Error(`terminal decision not found: ${decisionId}`);
  const intents = await db
    .select()
    .from(workflowTerminalEffectIntents)
    .where(and(
      eq(workflowTerminalEffectIntents.terminalDecisionId, decisionId),
      eq(workflowTerminalEffectIntents.status, "pending"),
    ))
    .orderBy(workflowTerminalEffectIntents.createdAt);
  let executed = 0;
  let failed = 0;
  for (const intent of intents) {
    const ok = await runSingleEffectIntent(db, intent, { companyId: decision.companyId, missionId: decision.missionId }, now);
    if (ok) executed += 1;
    else failed += 1;
  }
  return { executed, failed };
}

/** pending 인텐트의 지연 재처리 경로 — 재시도 한도 소진분은 실패 확정한다. */
export async function processPendingTerminalEffectIntents(
  db: Db,
  options?: { companyId?: string; olderThanMs?: number; maxAttempts?: number },
): Promise<TerminalEffectRunResult & { skipped: number }> {
  const now = new Date();
  const olderThanMs = options?.olderThanMs ?? 60_000;
  const maxAttempts = options?.maxAttempts ?? 5;
  const cutoff = new Date(now.getTime() - olderThanMs);
  const pendingFilters = [
    eq(workflowTerminalEffectIntents.status, "pending"),
    lte(workflowTerminalEffectIntents.createdAt, cutoff),
  ];
  if (options?.companyId) pendingFilters.push(eq(workflowTerminalEffectIntents.companyId, options.companyId));

  const exhausted = await db
    .update(workflowTerminalEffectIntents)
    .set({ status: "failed", lastError: "attempts exhausted" })
    .where(and(...pendingFilters, gte(workflowTerminalEffectIntents.attemptCount, maxAttempts)))
    .returning({ id: workflowTerminalEffectIntents.id });

  const rows = await db
    .select({ intent: workflowTerminalEffectIntents, missionId: workflowRuns.missionId })
    .from(workflowTerminalEffectIntents)
    .innerJoin(workflowTerminalDecisions, eq(workflowTerminalEffectIntents.terminalDecisionId, workflowTerminalDecisions.id))
    .innerJoin(workflowRuns, eq(workflowTerminalDecisions.workflowRunId, workflowRuns.id))
    .where(and(...pendingFilters, lt(workflowTerminalEffectIntents.attemptCount, maxAttempts)))
    .orderBy(workflowTerminalEffectIntents.createdAt)
    .limit(100);

  let executed = 0;
  let failed = 0;
  for (const row of rows) {
    const ok = await runSingleEffectIntent(
      db,
      row.intent,
      { companyId: row.intent.companyId, missionId: row.missionId },
      now,
    );
    if (ok) executed += 1;
    else failed += 1;
  }
  return { executed, failed, skipped: exhausted.length };
}
