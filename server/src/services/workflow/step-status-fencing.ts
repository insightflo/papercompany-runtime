// server/src/services/workflow/step-status-fencing.ts
//
// [purpose] workflow_step_runs 상태 전이의 중앙 작성자(스텝 상태 펜싱 v1).
//   heartbeat 의 setHeartbeatRunStatus(run-status fencing v1, #277)와 같은 계약을
//   step 테이블에 적용한다: expectedStatuses 를 넘기면 compare-and-set 이 되어
//   현재 상태가 목록에 없는 행은 갱신되지 않고(죽은/취소된 실행자의 늦은 상태 기록이
//   새 상태를 덮어쓰는 좀비쓰기 방지), 폐기 사실을 logger.info 로 남긴다.
//   미전달 시 기존 무조건 갱신 동작을 유지한다(호환).
//   status 값이 실제로 바뀔 때만 status_transition_version 트리거가 증가한다
//   (migration 0080 — 같은 값 재기입은 부작용 없음).

import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

export type WorkflowStepRunRow = typeof workflowStepRuns.$inferSelect;

export async function setWorkflowStepRunStatus(
  db: Db,
  input: {
    stepRunId: string;
    status: string;
    patch?: Partial<typeof workflowStepRuns.$inferInsert>;
    /** 기대 pre-state(CAS). 불일치 행은 0행 갱신 + 폐기 로그. */
    expectedStatuses?: readonly string[];
    /** 추가 AND 조건(세대 CAS 등) — 호출부의 기존 울타리를 그대로 보존한다. */
    extraConditions?: readonly SQL[];
  },
): Promise<WorkflowStepRunRow | null> {
  const expected = input.expectedStatuses?.length ? [...input.expectedStatuses] : null;
  const updated = await db
    .update(workflowStepRuns)
    .set({ status: input.status, ...input.patch })
    .where(and(
      eq(workflowStepRuns.id, input.stepRunId),
      ...(expected ? [inArray(workflowStepRuns.status, expected)] : []),
      ...(input.extraConditions ?? []),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!updated && expected) {
    logger.info(
      { stepRunId: input.stepRunId, attempted: input.status, expected },
      "fenced step-status write discarded",
    );
  }
  return updated;
}
