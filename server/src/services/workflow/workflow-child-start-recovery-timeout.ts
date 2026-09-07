// server/src/services/workflow/workflow-child-start-recovery-timeout.ts
//
// [purpose] stuck 회복의 링크 자식 분기 전용 모듈(cycle A §4). materialized 자식의 무조건 skip 을
//   없애고, 면제는 "미 materialized 링크 자식 + 유효한 전체 자동 소유 술어(OWNED_AUTO)"로 한정한다.
//   반환: 'native' = 영수증 또는 스텝 행 존재(또는 일반 run) → reconciler 의 기존 rework/active
//   step/issue/heartbeat/pending retry/child-wait 검사로 fall through. 'skipped' = 유효 소유/경합/
//   수리 불가 레거시. 'settled' = 자체 실패 CAS 로 정산함(0행 재검증 포함).
// [authority] 내구 레코드만이 권위(규칙 7/8). 모든 시간 판정은 DB clock_timestamp() SQL 술어.
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  ownedAutoIsTruePredicate,
  type ChildStartIdentityBound,
  type ChildStartTables,
} from "./workflow-child-start-predicates.js";
import {
  type ChildStartIdentity,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { repairWorkflowChildStartDiscovery } from "./workflow-child-discovery.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export type ChildStartTimeoutClassification = "native" | "skipped" | "settled";

const TIMEOUT_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "wct_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wct_child") as unknown as typeof workflowRuns,
};

/**
 * stuck run 의 링크 자식 분류(cycle A §4). 발견 → (레거시 claimed+child 는 먼저 수리) → 공통 잠금
 * 하 신선한 상태/시간/materialization 재판정 → OWNED_AUTO 면제 또는 0행 실패 CAS. 신원이 잠금 사이에
 * 사라지면 오래된 ID 로 쓰지 않고 skipped 로 양보한다.
 */
export async function reconcileUnmaterializedChildStartTimeout(
  db: Db,
  input: { childRunId: string; companyId: string; nativeTimeoutCutoff: Date },
): Promise<ChildStartTimeoutClassification> {
  // [cycle B F4] private 발견(discoverLegacyClaimedIdentity)을 공용 판별자로 교체한다. invalid-child
  //   는 skipped(fail-closed), plain/missing 은 native(reconciler 의 기존 force-fail 경로), linked/
  //   legacy(공용 수리 후 신선한 linked)는 잠금 하 분류로 진행한다. 수리는 별도 트랜잭션(잠금 밖)이다.
  const entry = await repairWorkflowChildStartDiscovery(db, input.childRunId);
  if (entry.kind === "plain") return "native"; // 일반 run — reconciler 의 기존 force-fail 경로가 계속 소관.
  if (entry.kind === "yield") return "skipped"; // invalid/경합/수리 불가 레거시 — 양보.
  return await classifyUnderLocks(db, entry.identity, input);
}

/** 공통 잠금 하 신선한 재판정 — native/skipped/settled 분류(cycle A §4). */
async function classifyUnderLocks(
  db: Db,
  identity: ChildStartIdentity,
  input: { childRunId: string; companyId: string; nativeTimeoutCutoff: Date },
): Promise<ChildStartTimeoutClassification> {
  try {
    return await db.transaction(async (tx): Promise<ChildStartTimeoutClassification> => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, identity);
      if (!ctx) return "skipped"; // 발견 후 신원 변경/소실 — 오래된 ID 로 쓰지 않는다.
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, ctx.child.id));
      // [cycle A §4] 영수증-only materialization 도 native 로 fall through — 영수증은 실행 증거가
      // 아니지만 zero-step 시작 실패의 소관도 아니다(다음 native pass 가 뒤따른다).
      if (ctx.child.childStartMaterializedAt !== null || count > 0) return "native";
      const t = TIMEOUT_TABLES;
      const b = boundOf(identity);
      const [owned] = await txDb
        .select({ owned: ownedAutoIsTruePredicate(t, b) })
        .from(t.child)
        .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
        .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
        .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
        .where(and(eq(t.child.id, identity.childRunId), eq(t.invocation.id, identity.invocationId)))
        .limit(1);
      if (owned?.owned === true) return "skipped"; // 유효한 자동 소유 상태 — 면제.
      // [cycle A §4] 최종 실패 CAS — NOT EXISTS 는 ownedAutoIsTruePredicate 와 "같은" 술어 빌더로
      // 만든다(손작성 부분집합 금지). 시간이 잠금 중에도 흐르므로 UPDATE 가 재평가한다.
      const forced = await tx
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: sql`clock_timestamp()`,
          childStartToken: null,
          childStartLeaseExpiresAt: null,
        })
        .where(and(
          eq(workflowRuns.id, ctx.child.id),
          eq(workflowRuns.companyId, input.companyId),
          sql`${workflowRuns.status} = 'running'`,
          sql`${workflowRuns.startedAt} < ${input.nativeTimeoutCutoff.toISOString()}`,
          sql`${workflowRuns.childStartMaterializedAt} is null`,
          sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${workflowRuns.id})`,
          sql`not exists (select 1
            from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
            where ${ownedAutoIsTruePredicate(t, b)}
              and ${t.child}.id = workflow_runs.id)`,
        ))
        .returning({ id: workflowRuns.id });
      return forced.length > 0 ? "settled" : "skipped";
    });
  } catch (error) {
    // [cycle A §8] 경합은 정산/실패로 이어지지 않는다 — owned 취급로 skipped(안전한 양보).
    if (isChildStartContention(error)) return "skipped";
    throw error;
  }
}

/** 레거시 발견은 workflow-child-discovery.ts 의 공용 판별자로 대체됐다(cycle B F4). */

function boundOf(identity: {
  companyId: string;
  invocationId: string;
  generation: number;
}): ChildStartIdentityBound {
  return { companyId: identity.companyId, invocationId: identity.invocationId, generation: identity.generation };
}
