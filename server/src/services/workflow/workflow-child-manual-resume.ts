// server/src/services/workflow/workflow-child-manual-resume.ts
//
// [purpose] 공개 수동 resume 의 링크 자식 준비 전용 모듈(cycle A §3). 무효화→획득의 두 트랜잭션이
//   아니라 "하나의" 공통 잠금 트랜잭션에서 IDENTITY/CURRENT 를 신선하게 재검증하고, 취소/완료 자식
//   부활을 거부하며(failed/running/pending 링크 자식은 허용), 오래된 토큰/임대 쌍을 무효화한다.
//   - 스텝 0행(빈 정의 영수증 포함): 운영자의 새 초기화 요청 — 영수증/마감을 재설정하고 새 UUID +
//     DB 시계 60초 임대 + 5분 마감을 발급, status=running/startedAt=DB now/completedAt=null 로
//     놓고 owned fence(intent manual-resume)를 돌려준다.
//   - 기존 행 존재: 영수증/마감/행 신원을 보존하고 토큰 쌍만 정리한 뒤 running/DB now 로 놓고
//     native 를 돌려준다(네이티브 sync 가 소관).
//   부모 상태/재시도 수/wait/invocation 세대는 절대 갱신하지 않는다. CURRENT 는 필수 — 수동이라도
//   오래된 세대의 자식을 되살리지 않는다. 시간 기록/판정은 전부 DB clock_timestamp()(규칙 7/8).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  type ChildStartFence,
  type ChildStartIdentity,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";
import { CHILD_START_DEADLINE_MS, CHILD_START_LEASE_MS } from "./workflow-child-start-lease.js";

export type ManualChildResumeOutcome =
  | { kind: "owned"; fence: ChildStartFence }
  | { kind: "native"; identity: ChildStartIdentity }
  | { kind: "busy" }
  | { kind: "ineligible" };

/**
 * 공개 수동 resume 의 자식 분류/준비 — 공통 잠금 한 트랜잭션(cycle A §3).
 * owned = 0행 재초기화(새 fence), native = materialized 네이티브 계속, busy = 경합,
 * ineligible = 신원/CURRENT 불일치 또는 취소/완료 자식.
 */
export async function prepareManualChildResume(
  db: Db,
  identity: ChildStartIdentity,
  options?: {
    /** [cycle B F3] 잠금 하 리셋 콜백 — txDb 만 받으며 외부 db 를 캡처해선 안 된다.
     *  준비 상태/토큰 준비 "이후" 커밋 "이전"에 실행되어 함께 롤백된다. ineligible 이면 호출 안 됨.
     */
    resetControls?: (txDb: Db) => Promise<void> | void;
    /** [cycle B F3] 기존 행(materialized) 경로에서 readiness/구조 검증이 "이미" 수행됐음을 표시.
     *  검증 없이 기존 행이 잠금 하 발견되면(0행 관측과의 경합) busy 로 양보한다(무검증 진입 금지).
     */
    validatedMaterialized?: boolean;
  },
): Promise<ManualChildResumeOutcome> {
  try {
    return await db.transaction(async (tx): Promise<ManualChildResumeOutcome> => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, identity);
      if (!ctx) return { kind: "ineligible" };
      const { child, parentStep, invocation } = ctx;
      // CURRENT — 수동 의도라도 오래된 세대는 되살리지 않는다(잠금 하 신선한 판정).
      if (parentStep.retryCount + 1 !== invocation.generation) return { kind: "ineligible" };
      // 취소 고정 + 완료 부활 금지. failed/running/pending 링크 자식은 운영자 복구 대상.
      if (child.status === "cancelled" || child.status === "completed") return { kind: "ineligible" };
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, child.id));
      if (count === 0) {
        // [cycle B F3] 0행 — 리셋은 명시적 no-op 이며 발급 fence 는 readiness/sync 까지 동일하다.
        if (options?.resetControls) await options.resetControls(txDb);
        return await issueManualInitialization(txDb, child.id, identity);
      }
      // 기존 행 존재 — 검증이 선행되지 않았으면(0행 관측 경합) 무검증 진입 대신 busy 로 양보.
      if (options?.validatedMaterialized !== true) return { kind: "busy" };
      // 영수증/마감/행 신원 보존, 토큰 쌍만 정리, 네이티브 계속으로 위임. 리셋은 같은 tx 안.
      if (options?.resetControls) await options.resetControls(txDb);
      await tx
        .update(workflowRuns)
        .set({
          childStartToken: null,
          childStartLeaseExpiresAt: null,
          status: "running",
          startedAt: sql`clock_timestamp()`,
          completedAt: null,
        })
        .where(and(
          eq(workflowRuns.id, child.id),
          eq(workflowRuns.companyId, identity.companyId),
          sql`${workflowRuns.status} not in ('cancelled', 'completed')`,
        ));
      return { kind: "native", identity };
    });
  } catch (error) {
    // [cycle A §8] 경합(lock_timeout/deadlock/serialization)은 롤백 후 busy — 정산/대체 쓰기 없음.
    if (isChildStartContention(error)) return { kind: "busy" };
    throw error;
  }
}

/**
 * 0행 재초기화 — 오래된 영수증/마감을 재설정하고 새 UUID 토큰 + DB 시계 60초 임대 + 5분 마감을
 * 발급한다. UPDATE 의 조건부 술어는 잠금 하 판정의 재환이다(0행이면 fail-closed).
 * 발급에 성공하면 owned fence(intent manual-resume)를 돌려준다.
 */
async function issueManualInitialization(
  tx: Db,
  childRunId: string,
  identity: ChildStartIdentity,
): Promise<ManualChildResumeOutcome> {
  const deadlineInterval = sql`${`${CHILD_START_DEADLINE_MS} milliseconds`}::interval`;
  const leaseInterval = sql`${`${CHILD_START_LEASE_MS} milliseconds`}::interval`;
  const token = randomUUID();
  const claimed = await tx
    .update(workflowRuns)
    .set({
      childStartToken: sql`${token}::uuid`,
      childStartDeadlineAt: sql`clock_timestamp() + ${deadlineInterval}`,
      childStartLeaseExpiresAt: sql`least(clock_timestamp() + ${leaseInterval}, clock_timestamp() + ${deadlineInterval})`,
      childStartMaterializedAt: null,
      status: "running",
      startedAt: sql`clock_timestamp()`,
      completedAt: null,
    })
    .where(and(
      eq(workflowRuns.id, childRunId),
      eq(workflowRuns.companyId, identity.companyId),
      sql`${workflowRuns.status} not in ('cancelled', 'completed')`,
      sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${childRunId})`,
    ))
    .returning({ id: workflowRuns.id, childStartToken: workflowRuns.childStartToken });
  if (!claimed[0]?.childStartToken) return { kind: "ineligible" };
  return {
    kind: "owned",
    fence: { identity, token: claimed[0].childStartToken, intent: "manual-resume" },
  };
}
