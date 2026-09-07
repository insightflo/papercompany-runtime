// server/src/services/workflow/workflow-child-legacy-link.ts
//
// [purpose] 레거시 coherent claimed+nonnull-child 영수증의 판별자(state) 수리 전용 모듈(cycle A §10).
//   원래 r2 픽스처처럼 state 없이 저장된 claimed+자식 행은 linked 전용 잠금 검증을 통과하지 못한다.
//   이 모듈은 공통 잠금 하에서 state 링크 요구를 제외한 전체 IDENTITY 정합 + 자식 존재 + 자격을
//   재검증한 뒤, state 만 claimed→linked 로 CAS 한다(wait/child/status/세대/메타데이터 불변).
//   wait 를 정의에서 재추론하지 않는다 — 내구 invocation.wait 가 권위다(ModeCrash 기본 true 유지).
// [authority] 내구 레코드만이 권위(규칙 7/8). 자격 판정은 SQL 술어(auto/dead)로 잠금 하 재평가.
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import { autoPredicate, deadParentPredicate, type ChildStartTables } from "./workflow-child-start-predicates.js";
import type { ChildStartIdentity } from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export type LegacyChildLinkRepair = "linked" | "unchanged" | "ineligible" | "busy";

const LEGACY_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "wcl_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wcl_child") as unknown as typeof workflowRuns,
};

/**
 * 레거시 판별자 수리 — claimed→linked CAS(cycle A §10). state='linked' 요구를 제외한 전체
 * IDENTITY 연결(회사/부모/스텝/자식/세대)과 자식 행 존재를 검증하고, 자격은 AUTO 또는 DEAD
 * (죽은 부모 정리는 CURRENT/retry/상태 자격을 대신한다)로 판정한다. 이미 linked 면 'unchanged'.
 * 경합은 'busy'. 수리 실패 시 plain-run fallback 은 없다 — 호출자가 fail-closed 로 양보한다.
 */
export async function repairLegacyChildLink(
  db: Db,
  identity: ChildStartIdentity,
): Promise<LegacyChildLinkRepair> {
  try {
    return await db.transaction(async (tx): Promise<LegacyChildLinkRepair> => {
      const txDb = tx as unknown as Db;
      await txDb.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);
      const [parent] = await txDb
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, identity.parentRunId))
        .for("update")
        .limit(1);
      if (!parent || parent.companyId !== identity.companyId) return "ineligible";
      const [invocation] = await txDb
        .select()
        .from(workflowStepInvocations)
        .where(eq(workflowStepInvocations.id, identity.invocationId))
        .for("update")
        .limit(1);
      if (!invocation || invocation.companyId !== identity.companyId) return "ineligible";
      if (invocation.parentStepRunId !== identity.parentStepRunId) return "ineligible";
      if (invocation.childRunId !== identity.childRunId || !invocation.childRunId) return "ineligible";
      if (invocation.generation !== identity.generation) return "ineligible";
      const [parentStep] = await txDb
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.id, identity.parentStepRunId))
        .for("update")
        .limit(1);
      if (!parentStep || parentStep.workflowRunId !== parent.id) return "ineligible";
      const [child] = await txDb
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, identity.childRunId))
        .for("update")
        .limit(1);
      if (!child || child.companyId !== identity.companyId) return "ineligible";
      if (child.parentRunId !== parent.id || child.parentStepRunId !== parentStep.id) return "ineligible";
      if (invocation.state === "linked") return "unchanged";
      if (invocation.state !== "claimed") return "ineligible";
      const t = LEGACY_TABLES;
      const [eligible] = await txDb
        .select({ ok: sql`(${autoPredicate(t)} or ${deadParentPredicate({ parent: t.parent, invocation: t.invocation })}) is true` })
        .from(t.child)
        .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
        .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
        .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
        .where(sql`${t.child}.id = ${identity.childRunId} and ${t.invocation}.id = ${identity.invocationId}`)
        .limit(1);
      if (eligible?.ok !== true) return "ineligible";
      // CAS — state 만 변경한다. wait/child/status/generation/metadata 는 절대 건드리지 않는다.
      const repaired = await tx
        .update(workflowStepInvocations)
        .set({ state: "linked" })
        .where(sql`${workflowStepInvocations.id} = ${invocation.id}
          and ${workflowStepInvocations.companyId} = ${identity.companyId}
          and ${workflowStepInvocations.generation} = ${identity.generation}
          and ${workflowStepInvocations.childRunId} = ${identity.childRunId}
          and ${workflowStepInvocations.state} = 'claimed'`)
        .returning({ id: workflowStepInvocations.id });
      return repaired.length > 0 ? "linked" : "ineligible";
    });
  } catch (error) {
    if (isChildStartContention(error)) return "busy";
    throw error;
  }
}
