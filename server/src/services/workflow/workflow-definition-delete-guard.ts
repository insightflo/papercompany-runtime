// server/src/services/workflow/workflow-definition-delete-guard.ts
//
// [purpose] descope D6 + r8 finding 1 — 정의 보관/삭제 가드의 애플리케이션 측 진입. 활성
//   activation 판정은 0101 의 캐논컬 SQL 함수 workflow_definition_has_active_child_invocations()
//   하나로만 한다(앱/양쪽 트리거 공유 — 손복사 술어 2본체 금지). 완전 정산+법정(valid settled)
//   이 아닌 연관 행 하나라도 있으면 거부한다(불량 참조 fail-closed 포함, r8 §1).
//   (1) lock_timeout(500ms) 후 정의 행 FOR UPDATE — 클레임(정의 FOR SHARE)과 직렬화,
//   (2) 같은 트랜잭션에서 캐논컬 가드 재호출해 typed 409 로 거부,
//   (3) 0101 트리거(archive UPDATE/DELETE)가 2차 방어선.
//   잠금 경합(55P03/40P01/40001)은 busy(structured 409) — 보관/삭제는 없다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 구조화 SQLSTATE 만 경합으로 분류한다(텍스트 금지).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowDefinitions } from "@paperclipai/db";
import { conflict } from "../../errors.js";

/** [D6] 활성 invocation 존재 시의 typed 거부 코드(공개 409 계약). */
export const WORKFLOW_DEFINITION_ACTIVE_CHILD_INVOCATIONS = "workflow_definition_has_active_child_invocations";

/** [D6] 정의 보관(archive-only UPDATE) — 거부/경합 구조는 모듈 헤더 참조. false = 정의 없음. */
export async function archiveWorkflowDefinitionWithGuard(db: Db, id: string): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);
      const [definition] = await txDb
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .for("update")
        .limit(1);
      if (!definition) return false;
      // [r8 §1] 활성 재검사 — 캐논컬 DB 함수 단일 호출(회사 경계는 잠긴 행으로 확정된 뒤
      // 최종 UPDATE 의 company_id 바인딩으로 강제된다). VOLATILE 함수이므로 잠금 획득 이전에
      // 커밋된 클레임도 관측한다.
      const activeRows = await txDb.execute(sql`
        select workflow_definition_has_active_child_invocations(${definition.id}::uuid) as active
        limit 1`);
      const first = (activeRows[0] ?? {}) as { active?: boolean };
      if (first.active === true) {
        throw conflict(`${WORKFLOW_DEFINITION_ACTIVE_CHILD_INVOCATIONS}: workflow ${definition.id} still has active child invocations`);
      }
      const rows = await txDb
        .update(workflowDefinitions)
        .set({ status: "archived", updatedAt: new Date() })
        // [r8 §1] 최종 UPDATE 도 대상 id+회사+가드를 재평가한다(잠금 대기 중 상태 변경 방어).
        .where(and(
          eq(workflowDefinitions.id, id),
          eq(workflowDefinitions.companyId, definition.companyId),
          sql`not workflow_definition_has_active_child_invocations(${workflowDefinitions.id})`,
        ))
        .returning({ id: workflowDefinitions.id });
      return rows.length > 0;
    });
  } catch (error) {
    // [설계 §3] 구조화 SQLSTATE 경합만 busy 로 분류한다 — 원본 오류는 그대로 전파한다.
    if (isDefinitionGuardContention(error)) {
      throw conflict(`workflow_definition_archival_busy: workflow ${id} archival lock timed out; retry`);
    }
    throw error;
  }
}

/** SQLSTATE 55P03/40P01/40001 경합 분류(code/cause 체인만 — 텍스트/숫자 코드 매칭 금지). */
function isDefinitionGuardContention(error: unknown, depth = 0): boolean {
  if (depth > 5 || error == null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string"
    && (candidate.code === "55P03" || candidate.code === "40P01" || candidate.code === "40001")) return true;
  return isDefinitionGuardContention(candidate.cause, depth + 1);
}
