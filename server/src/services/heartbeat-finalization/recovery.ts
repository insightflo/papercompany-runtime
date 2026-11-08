import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { lifecycleActiveClause } from "./lifecycle-active.js";
import { attemptFullSettlement } from "./settlement.js";
import { syncWorkflowAfterHeartbeatSettlement } from "./post-execution.js";
import { publishLiveEvent } from "../live-events.js";

/**
 * [C2 2026-11-08] 정산 후 표시/슬롯 기준 일치: 이 run 의 정산으로 해당 에이전트의
 * lifecycle-active run 이 0 이 되고 표시가 아직 'running' 이면 idle 로 회복한다.
 * finalizeAgentStatus 와 같은 카운트 기준(lifecycleActiveClause)을 쓰되, 이 경로는
 * 회복 교정만 담당하므로 'running' 외 상태는 변경하지 않는다.
 */
async function releaseAgentDisplayStatusAfterSettlement(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  now: Date,
): Promise<void> {
  const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents).where(eq(agents.id, run.agentId));
  if (!agent || agent.status !== "running") return;
  const clause = await lifecycleActiveClause(db);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, run.agentId), clause));
  if (Number(count ?? 0) > 0) return;
  const [updated] = await db.update(agents).set({ status: "idle", updatedAt: now })
    .where(and(eq(agents.id, run.agentId), eq(agents.status, "running"))).returning();
  if (updated) {
    publishLiveEvent({
      companyId: agent.companyId,
      type: "agent.status",
      payload: { agentId: agent.id, status: "idle", outcome: run.status },
    });
  }
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];

/**
 * Phase 3 recovery (plan section 5, M1/N3): replays settlement for v1 runs that
 * reached terminal status but were not settled (crash window between setRunStatus
 * and settlement). After a fixed grace, re-attempts the full settlement pipeline:
 * ensureFinalization -> observe quiescence -> record Q stages if proven -> settle.
 *
 * FLAG-GATED: with the flag OFF, this is a no-op. With the flag ON, a recovered
 * settlement makes the run lifecycle-inactive and its linked workflow step dispatch-ready.
 *
 * Returns the number of runs processed.
 */
export async function recoverTerminalUnsettledRuns(
  db: Db,
  now: Date = new Date(),
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<number> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return 0;

  const cutoff = new Date(now.getTime() - graceMs);
  const cutoffIso = cutoff.toISOString();
  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      finalizationVersion: heartbeatRuns.finalizationVersion,
      settledAt: heartbeatRuns.settledAt,
    })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.status, TERMINAL_STATUSES),
      eq(heartbeatRuns.finalizationVersion, 1),
      isNull(heartbeatRuns.settledAt),
      sql`COALESCE(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) < ${cutoffIso}`,
    ))
    .limit(50);

  let processed = 0;
  for (const candidate of candidates) {
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
      if (!run || run.finalizationVersion !== 1 || run.settledAt) continue;

      // Every terminal-unsettled v1 run replays the same full settlement pipeline
      // the normal execution path uses. settleRunIfReady alone never materializes
      // the compensable C stages (issue promotion / workflow evidence sync), so
      // runs that terminalized with any other error code (adapter_failed,
      // issue_status_blocked, cancelled, timed_out, ...) stayed pending forever,
      // kept their sources classified as stale, and fed the unblock-anchor loop.
      const settlement = await attemptFullSettlement(db, run, now);
      if (settlement === "settled") {
        // [C2 2026-11-08] 정산이 슬롯 점유를 회수하면 표시 상태도 같은 기준으로 회복한다.
        // 종료 정리/시작 스윕이 미정산 점유 동안 유지한 'running' 표시만 교정한다(best-effort,
        // 워크플로 동기화를 막지 않는다). paused/terminated·idle 에이전트는 건드리지 않는다.
        await releaseAgentDisplayStatusAfterSettlement(db, run, now).catch(() => undefined);
        await syncWorkflowAfterHeartbeatSettlement(db, run);
      }
      processed += 1;
    } catch {
      // Recovery is best-effort; individual failures are retried on the next tick.
    }
  }
  return processed;
}
