// server/src/services/workflow/workflow-cancel-bridge.ts
//
// [purpose] descope v1 — oversized dag-engine 이 bounded 호출로 쓰는 "자식 인지(child-aware)"
//   취소/finalization 경계 로직 전용 모듈(설계 §5 — 신규 로직을 legacy 대형 파일 밖에 둔다).
//   - run 취소: 링크 자식은 공유 전체 신원(BASE_ID/CURRENT) fence 취소 헬퍼로만 변이되고,
//     무효 표지 run 은 무변환 거부(fail-closed), plain 은 명시적 no-child 가드가 있는 기존
//     조건부 UPDATE 다. company+run-only 우회는 없다(D5 — DAG:3604 유추 삭제).
//   - run finalization: 링크 자식의 최종 UPDATE 가 같은 문장에서 BASE_ID+CURRENT+회사를
//     바인딩하고, 성공은 materialized 영수증을 요구하며 pair 를 해제한다. invalid-child 는
//     무변환 거부다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 최종 변이의 WHERE 가 잠금/시점 이후 신원을
//   재평가하며, 감사 기록은 실행 권위가 없다.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { discoverWorkflowChildStart } from "./workflow-child-discovery.js";
import { claimDirectlyCancelledLinkedChildRun } from "./workflow-child-direct-cancel.js";
import { claimCancelledChildRunWithParentFence } from "./workflow-child-start-state.js";
import {
  baseIdPredicate,
  currentPredicate,
  type ChildStartTables,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";

const WORKFLOW_RUN_TERMINAL_STATUSES_SQL = sql`('completed', 'cancelled', 'aborted', 'failed', 'timed-out')`;

export type CancelledRunRef = { id: string; companyId: string; missionId: string | null };

export type ChildParentFenceInput = {
  invocationId: string;
  generation: number;
  parentRunId: string;
  parentStepRunId: string;
};

/**
 * finalization 의 링크 자식 바인딩 술어용 테이블 별칭. [r9 §1] child 는 갱신 대상 실제
 * workflow_runs 다(EXISTS self-join 별칭 제거 — 별칭 C 행의 스테일 판정이 결함 근원). P 만 별칭.
 */
const FINALIZE_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "wcb_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: workflowRuns,
};

/**
 * run 1개 취소의 자식 인지 분류. suppliedFence 가 있으면 그 fence 로(회복 경로 — 헬퍼가 잠금 하
 * 재검증), 없으면 읽기 전용 발견으로 fence/plain/invalid 를 정한다. refusedInvalidReason 이
 * 있으면 실행 행은 무변환이고, rows 가 비었으면 취소 불성립(경합/종말)이다.
 */
export async function cancelWorkflowRunWithChildFence(
  db: Db,
  input: {
    runId: string;
    companyId: string;
    suppliedFence?: ChildParentFenceInput;
  },
): Promise<{ rows: CancelledRunRef[]; refusedInvalidReason?: string }> {
  if (input.suppliedFence) {
    return {
      rows: await claimCancelledChildRunWithParentFence(db, {
        childRunId: input.runId,
        companyId: input.companyId,
        fence: input.suppliedFence,
      }),
    };
  }
  const discovery = await discoverWorkflowChildStart(db, input.runId);
  if (discovery.kind === "linked") {
    const identity = discovery.identity;
    // [r8 finding 3] 무 fence 직접 취소 — DEAD 전용 전파 정산 헬퍼가 아닌 직접 취소 writer 를
    // 쓴다(살아있는 부모 아래 유효 비종말 자식도 운영자 취소가 가능). company 는 요청값을 그대로
    // 바인딩한다(발견된 자식의 company 로 대체 금지 — 불일치는 writer 의 잠금 검증이 [] 로 거부).
    const result = await claimDirectlyCancelledLinkedChildRun(db, {
      companyId: input.companyId,
      parentRunId: identity.parentRunId,
      parentStepRunId: identity.parentStepRunId,
      stepId: identity.stepId,
      invocationId: identity.invocationId,
      generation: identity.generation,
      childRunId: identity.childRunId,
    });
    return { rows: result.outcome === "cancelled" ? result.rows : [] };
  }
  if (discovery.kind === "invalid-child") {
    return { rows: [], refusedInvalidReason: discovery.reason };
  }
  // plain — 자식 표지/참조가 하나라도 있으면 이 문장은 0행이다(명시적 no-child 가드).
  const rows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      childStartToken: null,
      childStartLeaseExpiresAt: null,
    })
    .where(and(
      eq(workflowRuns.id, input.runId),
      eq(workflowRuns.companyId, input.companyId),
      sql`${workflowRuns.status} not in ${WORKFLOW_RUN_TERMINAL_STATUSES_SQL}`,
      sql`${workflowRuns.triggeredBy} <> 'workflow-step'`,
      sql`${workflowRuns.parentRunId} is null`,
      sql`${workflowRuns.parentStepRunId} is null`,
      sql`not exists (
        select 1 from workflow_step_invocations wcb_i where wcb_i.child_run_id = ${workflowRuns.id})`,
    ))
    .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });
  return { rows };
}

/**
 * 자손 순회의 자손 1개 취소. 링크 자식은 전체 신원 fence 취소, 무효 링크는 감사 후 스킵
 * (mutate only valid links), plain 은 기존 조건부 UPDATE 다.
 */
export async function cancelDescendantWorkflowRunWithChildFence(
  db: Db,
  child: {
    id: string;
    companyId: string;
    parentRunId: string | null;
    parentStepRunId: string | null;
    triggeredBy: string;
  },
): Promise<boolean> {
  const childMarked = child.parentRunId !== null
    || child.parentStepRunId !== null
    || child.triggeredBy === "workflow-step";
  if (childMarked) {
    const discovery = await discoverWorkflowChildStart(db, child.id);
    if (discovery.kind === "linked") {
      const identity = discovery.identity;
      const cancelled = await claimCancelledChildRunWithParentFence(db, {
        childRunId: child.id,
        companyId: child.companyId,
        fence: {
          invocationId: identity.invocationId,
          generation: identity.generation,
          parentRunId: identity.parentRunId,
          parentStepRunId: identity.parentStepRunId,
        },
      });
      return cancelled.length > 0;
    }
    if (discovery.kind === "invalid-child") {
      await logWorkflowRunCancellationRefused(db, child.companyId, child.id, discovery.reason);
      return false;
    }
    // missing/plain 발견 — 아래 plain UPDATE 가 0행/1행을 스스로 판정한다.
  }
  const propagated = await db
    .update(workflowRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(and(
      eq(workflowRuns.id, child.id),
      eq(workflowRuns.companyId, child.companyId),
      sql`${workflowRuns.status} not in ${WORKFLOW_RUN_TERMINAL_STATUSES_SQL}`,
    ))
    .returning({ id: workflowRuns.id });
  return propagated.length > 0;
}

/**
 * native run finalization 의 자식 게이트. linked 는 최종 UPDATE 가 같은 문장에서 평가할
 * 바인딩 WHERE(BASE_ID+CURRENT+회사, 성공은 materialized 영수증)와 pair 해제 패치를 실어
 * 반환한다. invalid-child 는 refused-invalid(무변환 fail-closed), plain 은 기존 경로다.
 */
export async function resolveWorkflowRunFinalizationGate(
  db: Db,
  input: { runId: string; companyId: string; nextStatus: string },
): Promise<
  | { kind: "refused-invalid"; reason: string }
  | { kind: "plain" }
  | { kind: "linked"; bound: WorkflowChildIdentity; extraPatch: { childStartToken: null; childStartLeaseExpiresAt: null }; boundWhere: SQL }
> {
  const discovery = await discoverWorkflowChildStart(db, input.runId);
  if (discovery.kind === "invalid-child") {
    return { kind: "refused-invalid", reason: discovery.reason };
  }
  if (discovery.kind !== "linked") return { kind: "plain" };
  // [r9 §1] 세대 축소를 조용히 하지 않는다 — 1이 아니면 발견 자체가 무효다.
  if (discovery.identity.generation !== 1) {
    return { kind: "refused-invalid", reason: "workflow child generation != 1" };
  }
  const bound: WorkflowChildIdentity = { ...discovery.identity, generation: 1 };
  const t = FINALIZE_TABLES;
  const c = workflowRuns;
  const boundWhere = and(
    // [r9 §1] 대상 C 자신의 전체 바인딩 — 신원 + 현재 상태(비종말만 쓴다) + completed 보존 규칙.
    eq(c.id, input.runId),
    eq(c.id, bound.childRunId),
    eq(c.companyId, input.companyId),
    eq(c.parentRunId, bound.parentRunId),
    eq(c.parentStepRunId, bound.parentStepRunId),
    sql`${c.status} in ('pending', 'running')`,
    sql`${input.nextStatus} in ('running', 'completed', 'failed', 'cancelled')`,
    sql`(${input.nextStatus} <> 'completed' or ${c.childStartMaterializedAt} is not null)`,
    // P/I/S 잠금 재평가(EXISTS — C 는 FROM 에 없다; baseIdPredicate 가 대상 C 를 상관 참조).
    sql`exists (select 1
      from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}
      where ${baseIdPredicate(t, bound)}
        and ${currentPredicate(t)}
        and ${t.invocation}.target_workflow_id = ${c.workflowId})`,
 )!;
  return {
    kind: "linked",
    bound,
    extraPatch: { childStartToken: null, childStartLeaseExpiresAt: null },
    boundWhere,
  };
}

/** finalization 거부/게이트 상실 구조화 감사 — 실행 행은 무변경이며 회복 경로의 소관이다. */
export async function logWorkflowRunFinalizationRefused(
  db: Db,
  input: { companyId: string; runId: string; reason: string },
): Promise<void> {
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "workflow-engine",
      action: "workflow_run.finalization_refused",
      entityType: "workflow_run",
      entityId: input.runId,
      details: { reason: input.reason },
    });
  } catch {
    // 감사 실패가 fail-closed 결과(무변경)를 바꾸지 않는다.
  }
}

/** 무효 자식 표지 run 취소 거부 감사 — 실행 행은 무변경이다(D5 fail-closed). */
export async function logWorkflowRunCancellationRefused(
  db: Db,
  companyId: string,
  runId: string,
  reason: string,
): Promise<void> {
  try {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "workflow-cancel",
      action: "workflow_run.cancellation_refused_invalid_child",
      entityType: "workflow_run",
      entityId: runId,
      details: { reason },
    });
  } catch {
    // 감사 실패가 무변환 거부 결과를 바꾸지 않는다.
  }
}
