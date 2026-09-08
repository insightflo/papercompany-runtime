// server/src/services/workflow/workflow-child-native-finalization.ts
//
// [purpose] r9 finding 1 — native run finalization 의 "유한 최종 변이" 전용 writer. 기존 결함은
//   dag-engine 의 직접 UPDATE 가 대상 C 의 현재 상태 술어 없이 제안 패치를 써서, 커밋된 cancelled
//   자식을 뒤늦은 native 동기화가 completed 로 덮어쓴 것이었다. 이 writer 는 자신의 트랜잭션에서
//   withLockedChildStartIdentity 로 P→I→S→C 권위 잠금을 획득하고(r9 §1), 대상 C 자신에 모든
//   신원/현재 상태(pending|running)/영수증/completed 보존 규칙/retained target 을 바인딩한
//   boundWhere(bridge 가 생성 — 외부 API 매개변수 아님)로 단일 UPDATE 를 실행한다. 종말 C 는
//   0행(updated 아님) — completed→completed 반복은 성공적 관찰(멱등 no-op)이지 새 쓰기/타임스탬프
//   정리가 아니다. winner 는 RETURNING 으로만 확정한다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 55P03/40P01/40001 만 busy, 알 수 없는 오류는 전파.
//   AUTO/P.running/S.pending 을 요구하지 않는다 — 그것은 정산/시작 정책이지 native finalization
//   계약이 아니다(r9 설계 §1).
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import { withLockedChildStartIdentity } from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";
import type { WorkflowChildIdentity } from "./workflow-child-start-predicates.js";

/** native finalization 이 쓸 수 있는 제안 상태 — DB CHECK 를 확장하지 않는다(abort/time-out 제외). */
const NATIVE_FINALIZE_NEXT_STATUSES = ["running", "completed", "failed", "cancelled"] as const;

export type NativeFinalizationPatch = {
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export type LinkedFinalizationResult =
  | { outcome: "updated"; run: typeof workflowRuns.$inferSelect }
  | { outcome: "no-op" | "busy" };

/**
 * [r9 §1] 최종 변이 후 내구 행 재적재 — 기대 run ID + 회사로 공급된 핸들에서 읽고, 없으면
 * 기존 run-not-found 오류를 전파한다(조합 행/완성 발명 금지). 관찰이지 쓰기 승자가 아니다.
 */
export async function reloadWorkflowRunForFinalization(
  db: Db,
  expected: { runId: string; companyId: string },
): Promise<typeof workflowRuns.$inferSelect> {
  const [durable] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, expected.runId), eq(workflowRuns.companyId, expected.companyId)))
    .limit(1);
  if (!durable) throw new Error(`Workflow run ${expected.runId} not found`);
  return durable;
}

/**
 * linked 자식 run 의 최종 상태 변이. 호출 조건: bound 는 linked gate 의 발견 신원(세대 1),
 * companyId 는 호출자가 기대하는 회사, boundWhere 는 보정된 bridge 가 만든 대상 재평가 술어다.
 * 트랜잭션 안에서 (1) 전체 신원 잠금 재검증 → 상실은 no-op, (2) 같은 핸들로 대상 UPDATE —
 * 최종 WHERE 가 잠금 대기 중 변경된 현재 상태/영수증/retained target 을 재평가한다.
 * 호출자가 외부 트랜잭션을 공급하면 그 핸들/세이브포인트를 쓴다(전역 연결 재취득 금지).
 */
export async function applyLinkedWorkflowRunFinalization(
  db: Db,
  input: {
    bound: WorkflowChildIdentity;
    companyId: string;
    nextStatus: string;
    patch: NativeFinalizationPatch;
    boundWhere: SQL;
  },
): Promise<LinkedFinalizationResult> {
  // [r9 §1] 변이 전 런타임 신원/회사 일치 — 불일치는 무변환 no-op(fail-closed).
  if (input.bound.generation !== 1) return { outcome: "no-op" };
  if (input.bound.companyId !== input.companyId) return { outcome: "no-op" };
  if (!(NATIVE_FINALIZE_NEXT_STATUSES as readonly string[]).includes(input.nextStatus)) {
    return { outcome: "no-op" };
  }
  try {
    const run = await db.transaction(async (tx): Promise<typeof workflowRuns.$inferSelect | null> => {
      const txDb = tx as unknown as Db;
      // [r9 §1] P→I→S→C 권위 잠금(기존 500ms lock/5s statement 한정 재사용). 신원 상실/치환은
      //   잠금 하 조기 no-op — 대체 링크를 따라가지 않는다(linked gate 전용).
      const ctx = await withLockedChildStartIdentity(txDb, input.bound);
      if (!ctx) return null;
      const rows = await txDb
        .update(workflowRuns)
        .set({
          status: input.nextStatus,
          // [r9 §1] SET 절은 설계 SQL 그대로 — COALESCE 는 UPDATE 대상의 기존값을 쓴다(잠금 보유).
          //   날짜 파라미터는 ISO 문자열 + 명시 캐스트(postgres.js bind 는 raw Date 를 거부한다).
          startedAt: sql`coalesce(${workflowRuns.startedAt}, ${input.patch.startedAt ? input.patch.startedAt.toISOString() : null}::timestamptz)`,
          completedAt: input.patch.completedAt ?? null,
          childStartToken: null,
          childStartLeaseExpiresAt: null,
        })
        .where(input.boundWhere)
        .returning();
      return (rows[0] as typeof workflowRuns.$inferSelect | undefined) ?? null;
    });
    return run ? { outcome: "updated", run } : { outcome: "no-op" };
  } catch (error) {
    // [r9 §1] 구조화 경합만 busy — 무관한 오류를 completed 로 은닉하지 않는다.
    if (isChildStartContention(error)) return { outcome: "busy" };
    throw error;
  }
}
