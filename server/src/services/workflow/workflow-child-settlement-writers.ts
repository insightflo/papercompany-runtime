// server/src/services/workflow/workflow-child-settlement-writers.ts
//
// [purpose] descope v1(설계 §4 DAG:3447 행) + r8 finding 2/4 — workflow→workflow 자식 스텝
//   정산의 "최종 변이 SQL writer" 전용 모듈. 세 형태만 존재하고 각자 자신의 트랜잭션에서
//   P→I→S(→C) 권위 잠금을 획득한 뒤(r8 §2 — self-join 별칭의 스테일 술어 제거), 갱신 대상
//   S(실제 workflow_step_runs 테이블)에 모든 신원/pending/retry/metadata 술어를 바인딩한다.
//   결과 payload 는 같은 문장의 bound C 행에서 선택된다. tombstone 형은 C 절 없이 P→I→S 잠금.
//   [r8 §4] linked 형은 법정 종말 게이트(완료=영수증 필수, 잔여 임대 쌍/스텝 행+무영수증 불법)를
//   잠금 하 분류하고, 불법이면 structured invalid-state + 감사 1건 — 변이 없다.
//   호출자가 공급한 status/wait/metadata 는 완료 권위가 절대 아니다. 0행은 typed no-op,
//   경합(55P03/40P01/40001)은 busy, 성공은 커밋 승리뿐이다. 승자 RETURNING 에서 company/
//   transition 을 유래시키며, 전이/동기화는 커밋 이후 실행된다(잠금 보유 중 외부 콜백 금지).
// [authority] 내구 DB 레코드만이 권위(규칙 7/8, 파싱 권위 없음).
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  recordSettlementWin,
  type SettlementTxResult,
  type SettlementWinner,
} from "./workflow-child-settlement-support.js";
import {
  baseIdPredicate,
  currentPredicate,
  tombstonePredicate,
  WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL,
  type WorkflowChildIdentity,
  type WorkflowChildTombstoneIdentity,
} from "./workflow-child-start-predicates.js";
import {
  classifyIllegalTerminalChild,
  countChildStepRows,
  legalTerminalChildPredicate,
  lockLinkedSettlementIdentity,
  recordCompletionRefusalActivity,
  withLockedTombstoneIdentity,
  type WorkflowChildInvalidTerminalReason,
} from "./workflow-child-settlement-support.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

/** 정산 결과 — settled 만 이 호출의 소유 정산이다. invalid-state 는 유한 사유의 구조화 거부. */
export type FailChildStepOutcome =
  | { outcome: "settled" | "no-op" | "busy" }
  | { outcome: "invalid-state"; code: "workflow_child_invalid_state"; version: 1; reason: WorkflowChildInvalidTerminalReason };

const TERMINAL_CHILD_STATUSES = ["completed", "cancelled", "aborted", "failed", "timed-out"];

/**
 * 정산 술어 테이블 — parentStep 은 갱신 대상 실제 테이블(r8 §2: UPDATE 대상이 아닌 별칭
 * self-join 의 스테일 판정이 결함 근원이었다). P/C 만 두 workflow_runs 역할 별칭이다.
 */
const SETTLE_TABLES = {
  parent: alias(workflowRuns, "wfc_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wfc_child") as unknown as typeof workflowRuns,
};

const TOMBSTONE_TABLES = {
  parent: SETTLE_TABLES.parent,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
};

/** UPDATE ... FROM 목록 — linked 형(P/I/C; S 는 갱신 대상이라 FROM 이 아니다). */
const FROM_LINKED = sql`from workflow_runs ${SETTLE_TABLES.parent}, workflow_step_invocations ${SETTLE_TABLES.invocation}, workflow_runs ${SETTLE_TABLES.child}`;

const FROM_TOMBSTONE = sql`from workflow_runs ${TOMBSTONE_TABLES.parent}, workflow_step_invocations ${TOMBSTONE_TABLES.invocation}`;

/** 공통 종말 자식 절 — bound C 는 반드시 기존 종말 run 상태여야 한다. */
const CHILD_TERMINAL = sql`${SETTLE_TABLES.child}.status in ${WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL}`;

/** [r8 §2] linked 최종 WHERE — 모든 S 술어가 갱신 대상 테이블을 직접 name 한다. */
function linkedTargetPredicate(b: WorkflowChildIdentity): ReturnType<typeof sql> {
  const t = SETTLE_TABLES;
  return sql`where ${baseIdPredicate(t, b)}
      and ${currentPredicate(t)}
      and ${t.parentStep}.status = 'pending'
      and ${t.parent}.status in ('running', 'cancelled')
      and ${CHILD_TERMINAL}
      and ${t.child}.workflow_id = ${t.invocation}.target_workflow_id
      and ${legalTerminalChildPredicate(t)}`;
}

/** [r8 §2] tombstone 최종 WHERE — C 절 완전 제거 + linked+NULL 재바인딩. */
function tombstoneTargetPredicate(b: WorkflowChildTombstoneIdentity): ReturnType<typeof sql> {
  const t = TOMBSTONE_TABLES;
  return sql`where ${tombstonePredicate(t, b)}`;
}

/** 경합 분류 공용 — 55P03/40P01/40001 만 busy, 나머지는 전파(롤백 후). */
function settlementBusy(error: unknown): boolean {
  return isChildStartContention(error);
}

/**
 * linked 형 실패 정산 — errorCode/detail 은 기계 값이며, childRunId/childStatus 는 같은 문장의
 * bound C 행에서 실린다. 자식이 종말이 아니거나 신원이 어긋나면 0행(no-op)이다. [r8 §4]
 * 불법 종말 초기화 상태(무영수증 완료 등)는 invalid-state 로 거부 — 변이/전이 없다.
 */
export async function failLinkedChildStep(
  db: Db,
  b: WorkflowChildIdentity,
  meta: { errorCode: string; detail: string },
): Promise<FailChildStepOutcome> {
  const t = SETTLE_TABLES;
  const nowIso = new Date().toISOString();
  try {
    const refusal = await db.transaction(async (tx): Promise<SettlementTxResult> => {
      const txDb = tx as unknown as Db;
      const ctx = await lockLinkedSettlementIdentity(txDb, b);
      if (!ctx) return { outcome: "no-op" };
      if (!TERMINAL_CHILD_STATUSES.includes(ctx.child.status)) return { outcome: "no-op" };
      const reason = classifyIllegalTerminalChild(ctx.child, await countChildStepRows(txDb, ctx.child.id));
      if (reason) return { refusal: reason };
      const result = await txDb.execute(sql`
        update workflow_step_runs
        set status = 'failed',
          started_at = coalesce(workflow_step_runs.started_at, ${nowIso}::timestamptz),
          completed_at = ${nowIso}::timestamptz,
          last_dispatch_error_at = ${nowIso}::timestamptz,
          last_dispatch_error_summary = ${meta.errorCode}::text,
          metadata = coalesce(workflow_step_runs.metadata, '{}'::jsonb) || jsonb_build_object('toolResult', jsonb_build_object(
            'toolName', 'workflow', 'success', false, 'stdout', null,
            'data', jsonb_build_object('ok', false, 'childRunId', ${t.child}.id, 'childStatus', ${t.child}.status, 'errorCode', ${meta.errorCode}::text, 'detail', ${meta.detail}::text),
            'stderr', ${meta.errorCode}::text, 'exitCode', 1, 'error', ${meta.errorCode}::text, 'completedAt', ${nowIso}::text))
        ${FROM_LINKED}
        ${linkedTargetPredicate(b)}
        returning workflow_step_runs.id as "stepRunId", workflow_step_runs.status as "toStatus", workflow_step_runs.status_transition_version as "transitionVersion", workflow_step_runs.issue_id as "issueId", ${t.parent}.id as "runId", ${t.parent}.company_id as "companyId", ${t.parent}.mission_id as "missionId"`);
      const winner = result[0] as unknown as SettlementWinner | undefined;
      return winner ? { winner } : { outcome: "no-op" as const };
    });
    if ("refusal" in refusal) {
      try {
        await recordCompletionRefusalActivity(db, b, refusal.refusal);
      } catch {
        // 감사 실패가 거부 결과를 대체하지 못한다.
      }
      return { outcome: "invalid-state", code: "workflow_child_invalid_state", version: 1, reason: refusal.refusal };
    }
    if ("winner" in refusal) {
      // [r8 §2] 커밋 승리 이후 전이/동기화(잠금 보유 중 외부 콜백 금지, 커밋된 handle 사용).
      try {
        await recordSettlementWin(db, refusal.winner);
      } catch {
        // 2차 기록 실패 — 소유 정산은 커밋됐다.
      }
      return { outcome: "settled" };
    }
    return refusal;
  } catch (error) {
    if (settlementBusy(error)) return { outcome: "busy" };
    throw error;
  }
}

/**
 * linked 형 완료/실패 정산(completion hook 의 최종 변이) — 성공/실패와 결과 payload 를 bound C 의
 * 내구 status 에서 같은 문장 안에서 선택한다. 호출자 status 힌트는 이 문장의 권위가 아니다.
 * [r8 §4] 법정 종말 게이트가 최종 UPDATE 에서 재평가된다.
 */
export async function settleLinkedChildStepFromTerminal(
  db: Db,
  b: WorkflowChildIdentity,
): Promise<FailChildStepOutcome> {
  const t = SETTLE_TABLES;
  const nowIso = new Date().toISOString();
  const errCode = sql`case when ${t.child}.status = 'cancelled' then 'child_run_cancelled' else 'child_run_failed' end`;
  const success = sql`(${t.child}.status = 'completed')`;
  try {
    const refusal = await db.transaction(async (tx): Promise<SettlementTxResult> => {
      const txDb = tx as unknown as Db;
      const ctx = await lockLinkedSettlementIdentity(txDb, b);
      if (!ctx) return { outcome: "no-op" };
      if (!TERMINAL_CHILD_STATUSES.includes(ctx.child.status)) return { outcome: "no-op" };
      const reason = classifyIllegalTerminalChild(ctx.child, await countChildStepRows(txDb, ctx.child.id));
      if (reason) return { refusal: reason };
      const result = await txDb.execute(sql`
        update workflow_step_runs
        set status = case when ${t.child}.status = 'completed' then 'completed' else 'failed' end,
          started_at = coalesce(workflow_step_runs.started_at, ${nowIso}::timestamptz),
          completed_at = ${nowIso}::timestamptz,
          dispatch_ready_at = case when ${success} and workflow_step_runs.dispatch_ready_at is null
            then ${nowIso}::timestamptz else workflow_step_runs.dispatch_ready_at end,
          last_dispatch_error_at = case when ${success} then null else ${nowIso}::timestamptz end,
          last_dispatch_error_summary = case when ${success} then null else ${errCode} end,
          metadata = coalesce(workflow_step_runs.metadata, '{}'::jsonb) || jsonb_build_object('toolResult', jsonb_build_object(
            'toolName', 'workflow', 'success', ${success},
            'stdout', case when ${success} then '' else null end,
            'data', jsonb_build_object('ok', ${success}, 'childRunId', ${t.child}.id, 'childStatus', ${t.child}.status),
            'stderr', case when ${success} then null else ${errCode} end,
            'exitCode', case when ${success} then 0 else 1 end,
            'error', case when ${success} then null else ${errCode} end,
            'completedAt', ${nowIso}::text))
        ${FROM_LINKED}
        ${linkedTargetPredicate(b)}
        returning workflow_step_runs.id as "stepRunId", workflow_step_runs.status as "toStatus", workflow_step_runs.status_transition_version as "transitionVersion", workflow_step_runs.issue_id as "issueId", ${t.parent}.id as "runId", ${t.parent}.company_id as "companyId", ${t.parent}.mission_id as "missionId"`);
      const winner = result[0] as unknown as SettlementWinner | undefined;
      return winner ? { winner } : { outcome: "no-op" as const };
    });
    if ("refusal" in refusal) {
      try {
        await recordCompletionRefusalActivity(db, b, refusal.refusal);
      } catch {
        // 감사 실패가 거부 결과를 대체하지 못한다.
      }
      return { outcome: "invalid-state", code: "workflow_child_invalid_state", version: 1, reason: refusal.refusal };
    }
    if ("winner" in refusal) {
      // [r8 §2] 커밋 승리 이후 전이/동기화(잠금 보유 중 외부 콜백 금지, 커밋된 handle 사용).
      try {
        await recordSettlementWin(db, refusal.winner);
      } catch {
        // 2차 기록 실패 — 소유 정산은 커밋됐다.
      }
      return { outcome: "settled" };
    }
    return refusal;
  } catch (error) {
    if (settlementBusy(error)) return { outcome: "busy" };
    throw error;
  }
}

/**
 * tombstone 형 정산 — linked+NULL invocation 의 bound pending S 를 child_run_failed 로 1회.
 * P→I→S 잠금(r8 §2), C 절 완전 제거, locked I 는 UPDATE 시점에도 linked+NULL 이어야 한다.
 */
export async function failTombstoneChildStep(
  db: Db,
  b: WorkflowChildTombstoneIdentity,
): Promise<FailChildStepOutcome> {
  const nowIso = new Date().toISOString();
  try {
    // tombstone 분류는 C 가 없어 refusal 을 만들 수 없다 — 결과 집합을 좁힌다.
    const settled = await db.transaction(async (tx): Promise<
      Exclude<SettlementTxResult, { refusal: WorkflowChildInvalidTerminalReason }>
    > => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedTombstoneIdentity(txDb, b);
      if (!ctx) return { outcome: "no-op" };
      const result = await txDb.execute(sql`
        update workflow_step_runs
        set status = 'failed',
          started_at = coalesce(workflow_step_runs.started_at, ${nowIso}::timestamptz),
          completed_at = ${nowIso}::timestamptz,
          last_dispatch_error_at = ${nowIso}::timestamptz,
          last_dispatch_error_summary = 'child_run_failed',
          metadata = coalesce(workflow_step_runs.metadata, '{}'::jsonb) || jsonb_build_object('toolResult', jsonb_build_object(
            'toolName', 'workflow', 'success', false, 'stdout', null,
            'data', jsonb_build_object('ok', false, 'errorCode', 'child_run_failed', 'detail', 'linked child workflow run was deleted (tombstone)'),
            'stderr', 'child_run_failed', 'exitCode', 1, 'error', 'child_run_failed', 'completedAt', ${nowIso}::text))
        ${FROM_TOMBSTONE}
        ${tombstoneTargetPredicate(b)}
        returning workflow_step_runs.id as "stepRunId", workflow_step_runs.status as "toStatus", workflow_step_runs.status_transition_version as "transitionVersion", workflow_step_runs.issue_id as "issueId", ${TOMBSTONE_TABLES.parent}.id as "runId", ${TOMBSTONE_TABLES.parent}.company_id as "companyId", ${TOMBSTONE_TABLES.parent}.mission_id as "missionId"`);
      const winner = result[0] as unknown as SettlementWinner | undefined;
      return winner ? { winner } : { outcome: "no-op" as const };
    });
    if ("winner" in settled) {
      // [r8 §2] 커밋 승리 이후 전이/동기화(잠금 보유 중 외부 콜백 금지, 커밋된 handle 사용).
      try {
        await recordSettlementWin(db, settled.winner);
      } catch {
        // 2차 기록 실패 — 소유 정산은 커밋됐다.
      }
      return { outcome: "settled" };
    }
    return settled;
  } catch (error) {
    if (settlementBusy(error)) return { outcome: "busy" };
    throw error;
  }
}
