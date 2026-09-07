// server/src/services/workflow/workflow-child-start-failure.ts
//
// [purpose] 소유 임대 하 자식 초기화 실패의 유일한 사전 materialization 정산 경로
//   (fix4 §2.2, cycle A §2/§5). readiness/structural 검증 실패 시 소유 승자만 실패 정산한다.
//   공통 잠금 + OWNER(intent) SQL 술어(없는 행/DB 시계 임대·마감/부모·현재 시도 자격 포함)를
//   한 UPDATE 에서 재평가한다. DB completedAt, 토큰/임대 쌍 정리, 마감 보존. 경합(55P03/40P01/
//   40001)은 정산하지 않고 busy 로 호출자에 전달한다(cycle A §8).
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import { ownerPredicate, type ChildStartIdentityBound, type ChildStartIntent, type ChildStartTables } from "./workflow-child-start-predicates.js";
import {
  type ChildStartIdentity,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export type FailOwnedWorkflowChildStartResult = { kind: "won" | "lost" | "busy" };

const FAILURE_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "csf_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "csf_child") as unknown as typeof workflowRuns,
};

/**
 * 소유자 실패 정산 — OWNER(intent) 술어를 통과한 승자만 failed/completedAt(DB 시계) + 토큰/임대
 * 쌍 정리 + 구조화 실패 메타데이터({workflowChildStartFailure:{version:1,errorCode}})를 한 커밋에
 * 기록한다. 마감(child_start_deadline_at)은 보존한다. 임대 패자/검증 불가 신원은 lost(no-op).
 * 경합은 busy — 호출자가 정산 대신 양보한다. 반환 won = 이 호출이 정산 승자(커밋 후 completion
 * hook 발화는 호출자 몫).
 */
export async function failOwnedWorkflowChildStart(
  db: Db,
  input: { identity: ChildStartIdentity; token: string; errorCode: string; intent?: ChildStartIntent },
): Promise<FailOwnedWorkflowChildStartResult> {
  const intent: ChildStartIntent = input.intent ?? "automatic";
  try {
    return await db.transaction(async (tx): Promise<FailOwnedWorkflowChildStartResult> => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, input.identity);
      if (!ctx) return { kind: "lost" };
      const base = ctx.child.metadata && typeof ctx.child.metadata === "object" && !Array.isArray(ctx.child.metadata)
        ? ctx.child.metadata as Record<string, unknown>
        : {};
      const t = FAILURE_TABLES;
      const b: ChildStartIdentityBound = {
        companyId: input.identity.companyId,
        invocationId: input.identity.invocationId,
        generation: input.identity.generation,
      };
      const updated = await tx
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: sql`clock_timestamp()`,
          childStartToken: null,
          childStartLeaseExpiresAt: null,
          metadata: {
            ...base,
            workflowChildStartFailure: { version: 1, errorCode: input.errorCode },
          },
        })
        .where(and(
          eq(workflowRuns.id, ctx.child.id),
          // [cycle A §2/§5] OWNER(intent) — IDENTITY/CURRENT/running/미 materialized(스텝 행·영수증
          // 없음)/호출자 토큰/임대·마감 미래(DB 시계)/의도별 부모·현재 자격을 한 UPDATE 에서 재평가.
          sql`exists (select 1
            from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
            where ${ownerPredicate(t, b, input.token, intent)}
              and ${t.child}.id = workflow_runs.id)`,
        ))
        .returning({ id: workflowRuns.id });
      return updated.length > 0 ? { kind: "won" } : { kind: "lost" };
    });
  } catch (error) {
    // [cycle A §8] 경합은 정산 없이 busy 로 전달한다(자동 롤백 후).
    if (isChildStartContention(error)) return { kind: "busy" };
    throw error;
  }
}
