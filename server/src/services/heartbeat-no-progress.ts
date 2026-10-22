import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { and, desc, eq, gte, inArray, lte, notLike } from "drizzle-orm";
import {
  NO_PROGRESS_RUN_SCAN_LIMIT,
  hasRunProgressEvidence,
  resolveNoProgressWindowMs,
} from "./heartbeat-stability.js";

export type NoProgressAssessment = {
  count: number;
  windowStart: Date;
  lastRunId: string | null;
  runsInspected: number;
  evidenceSummary: {
    runs: number;
    workProductRuns: number;
    transitionRuns: number;
    agentCommentsInWindow: number;
  };
};

/**
 * [no-progress ladder] 같은 issue+assignee의 종료(성공) run들을 최신순으로 훑으며
 *   진행 증거가 없는 run의 연쇄 길이를 매번 DB에서 재계산한다(stateless — 카운터 컬럼/메모리 없음).
 *   증거 판정은 hasRunProgressEvidence(구조화된 DB 기록만). 진행 증거가 있는 run에서 연쇄 리셋.
 *   창 밖(기본 6h)의 오래된 run은 새 컨텍스트에서 무의미하므로 제외(런어웨이 주입 창과 정렬).
 */
export async function computeConsecutiveNoProgress(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; now?: Date },
): Promise<NoProgressAssessment | null> {
  const windowMs = resolveNoProgressWindowMs();
  if (!(windowMs > 0)) return null;
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowMs);
  const emptyAssessment: NoProgressAssessment = {
    count: 0,
    windowStart,
    lastRunId: null,
    runsInspected: 0,
    evidenceSummary: { runs: 0, workProductRuns: 0, transitionRuns: 0, agentCommentsInWindow: 0 },
  };
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, input.issueId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "succeeded"),
      gte(heartbeatRuns.createdAt, windowStart),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(NO_PROGRESS_RUN_SCAN_LIMIT);
  if (runs.length === 0) return emptyAssessment;

  const runIds = runs.map((run) => run.id);
  const [workProductRows, transitionRows, commentRows] = await Promise.all([
    db
      .selectDistinct({ runId: issueWorkProducts.createdByRunId })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, input.issueId), inArray(issueWorkProducts.createdByRunId, runIds))),
    db
      .selectDistinct({ runId: workflowTransitionEvents.heartbeatRunId })
      .from(workflowTransitionEvents)
      .where(and(
        inArray(workflowTransitionEvents.heartbeatRunId, runIds),
        // queue_* 부기 이벤트(queue_run_started/completed 등)는 모든 run에 시스템이 남기는
        // 기록이라 진행 증거가 아니다. 워크플로 판정/전이(verdict, step 결과 등)만 증거로 인정.
        notLike(workflowTransitionEvents.eventType, "queue_%"),
      )),
    db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.agentId),
        gte(issueComments.createdAt, windowStart),
        lte(issueComments.createdAt, now),
      )),
  ]);
  const workProductRunIds = new Set(
    workProductRows.map((row) => row.runId).filter((value): value is string => Boolean(value)),
  );
  const transitionRunIds = new Set(
    transitionRows.map((row) => row.runId).filter((value): value is string => Boolean(value)),
  );
  const agentCommentTimestamps = commentRows.map((row) => row.createdAt);

  let count = 0;
  let lastRunId: string | null = null;
  for (const run of runs) {
    if (
      hasRunProgressEvidence({
        run,
        workProductRunIds,
        transitionRunIds,
        agentCommentTimestamps,
      })
    ) {
      break;
    }
    // lastRunId = 연쇄에서 가장 최근에 종료된 무진행 run(루프는 최신순).
    if (count === 0) lastRunId = run.id;
    count += 1;
  }
  return {
    count,
    windowStart,
    lastRunId,
    runsInspected: runs.length,
    evidenceSummary: {
      runs: runs.length,
      workProductRuns: workProductRunIds.size,
      transitionRuns: transitionRunIds.size,
      agentCommentsInWindow: agentCommentTimestamps.length,
    },
  };
}
