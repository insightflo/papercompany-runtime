// server/src/services/workflow/workflow-native-continuation.ts
//
// [purpose] [cycle B F4/F6] native-continuation 인가 전용 모듈. 모든 run 의 조기 반환 경로로
//   readiness/시작 트랜잭션/mission 활성화/임대 획득/재설정을 하지 않는다. 인가는
//   "running AND (영수증 OR 기존 행)" — 링크 자식은 공통 신원 잠금, plain 은 run-only 잠금,
//   둘 다 500ms/5s 로컬 한도다. 이 의도는 어떤 run 도 초기화하지 않는다.
// [authority] 내구 레코드(child_start_materialized_at / workflow_step_runs 행)만이 권위(규칙 7/8).
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { withLockedChildStartIdentity } from "./workflow-child-start-state.js";
import { repairWorkflowChildStartDiscovery } from "./workflow-child-discovery.js";
import type { WorkflowRunStartHooks, WorkflowRunStartOutcome } from "./workflow-run-start.js";

/**
 * [cycle A §3 + cycle B F4] native-continuation 실행 — 발견/레거시 수리를 인가 "이전에" 수행한다.
 * linked/legacy(수리 후)는 공통 신원 잠금 하 신선한 running+(영수증/행) 재판정, plain/missing 은
 * run-only 잠금 인가, invalid-child/수리 실패는 plain 인가로 떨어지지 않고 ineligible 스냅숏이다.
 * 잠금 해제 후 requireRunning+requireMaterialized sync 로 진입한다(영수증/행 소실 경합도
 * materializer 의 최종 재검증이 차단한다).
 */
export async function executeNativeContinuation(
  db: Db,
  runId: string,
  hooks: WorkflowRunStartHooks,
): Promise<WorkflowRunStartOutcome> {
  const entry = await repairWorkflowChildStartDiscovery(db, runId);
  if (entry.kind === "yield") {
    return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
  }
  const authorized = entry.kind === "proceed"
    ? await db.transaction(async (tx): Promise<boolean> => {
      const ctx = await withLockedChildStartIdentity(tx as unknown as Db, entry.identity);
      if (!ctx) return false;
      if (ctx.child.status !== "running") return false;
      if (ctx.child.childStartMaterializedAt !== null) return true;
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, ctx.child.id));
      return count > 0;
    })
    : await db.transaction(async (tx): Promise<boolean> => {
      const [row] = await tx
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update")
        .limit(1);
      return row?.status === "running";
    });
  if (!authorized) {
    return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
  }
  const syncOutcome = await hooks.sync(db, runId, "workflow_execution", { requireRunning: true, requireMaterialized: true });
  return { kind: syncOutcome.kind === "synced" ? "started" : "busy", result: syncOutcome.result };
}
