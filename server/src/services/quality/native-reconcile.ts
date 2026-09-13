// server/src/services/quality/native-reconcile.ts
//
// [purpose] T4 native 재조정. 기존 native 재조정기의 시작/주기 호출에 deliverQualityIntent
//   와 같은 전달 함수를 연결한다. 회사별 policy batch(nativeOwnership 일치·활성·기간 내)로
//   읽고 실패를 회사·조치 단위로 격리한다. pending canonical run 은 복구(같은 attempt 재전송)하고
//   terminal run 은 결과를 읽을 뿐 execute 를 다시 호출하지 않는다.
// [counter] waiting 은 accepted 에 합산한다(거절이 아니라 전달이 살아 있는 상태).

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { qualityActions, qualityPolicyVersions, workflowRuns } from "@paperclipai/db";
import { deliverQualityIntent } from "./native-delivery.js";

const TERMINAL_WORKFLOW_RUN = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);

/** nativeOwnership 이 일치하는 활성 정책을 가진 회사를 읽는다(회사별 batch). */
async function qualityCompaniesByOwnership(db: Db, ownership: string, now: Date): Promise<string[]> {
  const rows = await db.selectDistinct({ companyId: qualityPolicyVersions.companyId })
    .from(qualityPolicyVersions)
    .where(and(
      isNotNull(qualityPolicyVersions.approvedAt),
      isNotNull(qualityPolicyVersions.enabledAt),
      isNull(qualityPolicyVersions.disabledAt),
      sql`${qualityPolicyVersions.definition} ->> 'nativeOwnership' = ${ownership}`,
      sql`${qualityPolicyVersions.definition} ->> 'periodStart' <= ${now.toISOString()}`,
      sql`${qualityPolicyVersions.definition} ->> 'periodEnd' > ${now.toISOString()}`,
    ));
  return rows.map((row) => row.companyId);
}

export async function reconcileQualityIntents(db: Db, input: {
  ownership: string; now: Date;
}): Promise<{ visited: number; accepted: number; blocked: number }> {
  let visited = 0;
  let accepted = 0;
  let blocked = 0;
  const companyIds = await qualityCompaniesByOwnership(db, input.ownership, input.now);
  for (const companyId of companyIds) {
    let actions: Array<typeof qualityActions.$inferSelect>;
    try {
      actions = await db.select().from(qualityActions).where(and(
        eq(qualityActions.companyId, companyId),
        isNotNull(qualityActions.canonicalBinding),
        isNull(qualityActions.cancelRequestedAt),
      ));
    } catch {
      continue; // 회사 단위 격리: 이 회사의 읽기 실패가 다른 회사를 막지 않는다.
    }
    for (const action of actions) {
      visited += 1;
      try {
        const binding = action.canonicalBinding!;
        const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns)
          .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, binding.workflowRunId)))
          .limit(1);
        if (run && TERMINAL_WORKFLOW_RUN.has(run.status)) continue; // 결과만 읽는다(재실행 없음).
        const outcome = await deliverQualityIntent(db, { companyId, actionId: action.id });
        if (outcome.status === "blocked") blocked += 1;
        else accepted += 1; // accepted + waiting — 전달이 살아 있거나 수락됐다.
      } catch {
        blocked += 1; // 조치 단위 격리: 개별 실패는 차단으로 집계하고 계속한다.
      }
    }
  }
  return { visited, accepted, blocked };
}
