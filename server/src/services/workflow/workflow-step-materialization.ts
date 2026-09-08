// server/src/services/workflow/workflow-step-materialization.ts
//
// [purpose] descope v1(설계 §3/§4) 스텝 레코드 materialization 전용 모듈. run 행 잠금 직렬화 +
//   (run,step) 유일 인덱스 충돌 안전 insert + 자식 시작 fence(childStartFence) 원자 소비를 구현한다.
//   외부 dispatch 는 수행하지 않는다. 모든 시간 권위는 SQL clock_timestamp() 술어다 — JS Date
//   비교는 금지(규칙 7/8). 수동 resume/native-continuation 의도 옵션(requireRunning 등)과 미싱
//   초기행 재삽입/영수증 합성은 삭제됐다(D3) — 유효 materialized 자식은 기존 native sync 만 쓴다.
// [authority] 내구 레코드(workflow_runs.child_start_* / workflow_step_runs)만이 권위.
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  type ChildStartFence,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import {
  autoPredicate,
  ownerPredicate,
  timeValidPredicate,
  type ChildStartTables,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";
import {
  ChildStartFenceLostError,
  isChildStartContention,
  isChildStartFenceLost,
} from "./workflow-child-start-contention.js";

export type StepRunRow = typeof workflowStepRuns.$inferSelect;

export type MaterializationInput = {
  runId: string;
  steps: Array<{ id: string }>;
  childStartFence?: ChildStartFence;
  // [descope] native-continuation 전용 requireRunning 옵션은 삭제됐다(D3).
  /** [보존] 영수증 또는 기존 행이 없으면 not-owner — 초기화 금지 동기화 전용 진입. */
  requireMaterialized?: boolean;
  buildMetadata: (step: { id: string } & Record<string, unknown>) => Record<string, unknown>;
  syncControls: (db: Db, rows: StepRunRow[], steps: WorkflowStepLike[]) => Promise<StepRunRow[]>;
};

type WorkflowStepLike = { id: string } & Record<string, unknown>;

export type MaterializationOutcome =
  | { kind: "ready"; rows: StepRunRow[] }
  | { kind: "not-owner" }
  | { kind: "busy" };

const TERMINAL: string[] = ["completed", "cancelled", "aborted", "failed", "timed-out"];

/**
 * 스텝 레코드 materialization.
 * - fence 있음(실행 진입): 공통 잠금 후 OWNER SQL 술어로 소유를 재검증하고, 미 materialized 가
 *   아니면 삽입 전에 거부한다. 소유 승자는 스텝 행/메타 동기화를 같은 트랜잭션에 넣고 마지막에
 *   영수증 UPDATE를 소비한다 — 0행이면 fence 소실 센티널을 던져 전체 롤백하고, 센티널은 트랜잭션
 *   "외부"에서만 not-owner 로 변환된다. 경합(55P03/40P01/40001)은 busy 로 변환한다.
 * - fence 없음(generic sync): 종말 run 은 기존 행 읽기만 하고 초기 행을 삽입하지 않는다. child-marked
 *   run 은 linked invocation 검증 없이는 절대 plain-run 초기화로 떨어지지 않고, 미 materialized
 *   링크 자식은 거부한다. 유효 materialized 자식은 기존 행 동기화만 하고 미싱 초기행을 재삽입하지
 *   않는다(재초기화 금지, D3). 취소/없는 run 은 쓰기 전에 거부한다.
 */
export async function ensureWorkflowStepRunRecords(
  db: Db,
  input: MaterializationInput,
): Promise<MaterializationOutcome> {
  try {
    return await db.transaction(async (tx): Promise<MaterializationOutcome> => {
      await tx.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);
      const txDb = tx as unknown as Db;
      return input.childStartFence
        ? await materializeWithFence(txDb, input)
        : await materializeGeneric(txDb, input);
    });
  } catch (error) {
    // [설계 §3] fence 소실 센티널은 트랜잭션 외부에서만 not-owner 로 변환(내부 catch 는 롤백 파괴).
    // 경합(55P03/40P01/40001)은 busy — 메타 동기화 예외 등 나머지는 전파(롤백 후).
    if (isChildStartFenceLost(error)) return { kind: "not-owner" };
    if (isChildStartContention(error)) return { kind: "busy" };
    throw error;
  }
}

/** fence 하 materialization — OWNER 검증 → dedup insert → 메타 동기화 → 영수증 소비. */
async function materializeWithFence(db: Db, input: MaterializationInput): Promise<MaterializationOutcome> {
  const fence = input.childStartFence!;
  // [D2] 구세대 fence 는 소유가 될 수 없다.
  if (fence.identity.generation !== 1) return { kind: "not-owner" };
  if (input.runId !== fence.identity.childRunId) return { kind: "not-owner" };
  const ctx = await withLockedChildStartIdentity(db, fence.identity);
  if (!ctx) return { kind: "not-owner" };
  // [설계 §3] OWNER — 완전 신원(stepId 포함)/CURRENT/AUTO/running/미 materialized/토큰/임대·마감을
  // 잠금 하 fresh SQL 로 재평가한다. 기존 행·영수증 존재는 UNMATERIALIZED 가 삽입 전에 거부한다.
  if (!(await verifyOwnerFresh(db, fence.identity, fence.token))) {
    return { kind: "not-owner" };
  }
  const { rows } = await insertMissingStepRows(db, input);
  const syncedRows = await input.syncControls(db, rows, input.steps as WorkflowStepLike[]);
  // [설계 §3] 영수증 UPDATE는 쓰기 "마지막"에 수행된다. U 의 NOT EXISTS 스텝 행 조건은 포함하지
  // 않는다 — 이 트랜잭션이 방금 삽입했다. 0행이면 fence 소실 → 센티널로 전체 롤백.
  const t = predicateTables();
  const receipt = await db
    .update(workflowRuns)
    .set({
      childStartMaterializedAt: sql`clock_timestamp()`,
      childStartToken: null,
      childStartLeaseExpiresAt: null,
    })
    .where(and(
      eq(workflowRuns.id, input.runId),
      eq(workflowRuns.companyId, fence.identity.companyId),
      sql`exists (select 1
        from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
        where ${receiptOwnerPredicate(t, identityBound(fence.identity), fence.token)}
          and ${t.child}.id = workflow_runs.id)`,
    ))
    .returning({ id: workflowRuns.id });
  if (receipt.length === 0) throw new ChildStartFenceLostError();
  return { kind: "ready", rows: syncedRows };
}

/** generic sync — fence 없는 동기화의 쓰기 경계(설계 §3/§4). */
async function materializeGeneric(db: Db, input: MaterializationInput): Promise<MaterializationOutcome> {
  const [runRow] = await db
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
      companyId: workflowRuns.companyId,
      materializedAt: workflowRuns.childStartMaterializedAt,
      parentRunId: workflowRuns.parentRunId,
      parentStepRunId: workflowRuns.parentStepRunId,
      triggeredBy: workflowRuns.triggeredBy,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, input.runId))
    .for("update")
    .limit(1);
  // 없는 run / 취소 run — 어떤 쓰기도 하기 전에 거부.
  if (!runRow) return { kind: "not-owner" };
  if (runRow.status === "cancelled") return { kind: "not-owner" };
  // [보존] 영수증/행이 하나도 없으면 not-owner — authorization->sync 사이 행 삭제 경합도 차단.
  if (input.requireMaterialized && runRow.materializedAt === null) {
    const [cnt] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, input.runId));
    if ((cnt?.count ?? 0) === 0) return { kind: "not-owner" };
  }
  const existing = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.runId));
  const childMarked = runRow.triggeredBy === "workflow-step"
    || (runRow.parentRunId !== null && runRow.parentStepRunId !== null);
  const materialized = runRow.materializedAt !== null || existing.length > 0;
  if (childMarked) {
    // [설계 §4] child-marked run — linked invocation 검증 불가면 not-owner, 절대 plain-run
    // 초기화로 떨어지지 않는다. 미 materialized 링크 자식은 fence 없이는 거부다.
    if (!(await linkedInvocationCoherent(db, runRow))) return { kind: "not-owner" };
    if (!materialized) return { kind: "not-owner" };
    // [D3] 유효 materialized 자식 — 기존 native sync 만 사용한다. 미싱 초기행 재삽입/영수증
    // 합성(재초기화)은 금지; 종말 자식은 읽기만 반환한다. 동적 스텝 생성은 native 권위에 있다.
    if (TERMINAL.includes(runRow.status ?? "")) return { kind: "ready", rows: existing };
    const syncedRows = await input.syncControls(db, existing, input.steps as WorkflowStepLike[]);
    return { kind: "ready", rows: syncedRows };
  }
  if (TERMINAL.includes(runRow.status ?? "")) {
    // [보존] 종말 plain run — 기존 행만 읽기로 반환하고 초기 행 삽입/메타 쓰기를 하지 않는다.
    return { kind: "ready", rows: existing };
  }
  const existingStepIds = new Set(existing.map((stepRun) => stepRun.stepId));
  const { rows } = await insertMissingStepRows(db, input, existingStepIds);
  const syncedRows = await input.syncControls(db, rows, input.steps as WorkflowStepLike[]);
  return { kind: "ready", rows: syncedRows };
}

/** (run,step) 유일 키 ON CONFLICT DO NOTHING dedup insert 후 전체 행 재적재. */
async function insertMissingStepRows(
  db: Db,
  input: MaterializationInput,
  existingStepIds: Set<string> = new Set(),
): Promise<{ rows: StepRunRow[] }> {
  const stepsById = new Map(input.steps.map((step) => [step.id, step]));
  const missingSteps = Array.from(stepsById.values()).filter((step) => !existingStepIds.has(step.id));
  if (missingSteps.length > 0) {
    await db
      .insert(workflowStepRuns)
      .values(
        missingSteps.map((step) => ({
          id: randomUUID(),
          workflowRunId: input.runId,
          stepId: step.id,
          status: "pending",
          metadata: input.buildMetadata(step),
        })),
      )
      .onConflictDoNothing({
        target: [workflowStepRuns.workflowRunId, workflowStepRuns.stepId],
      });
  }
  return { rows: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.runId)) };
}

/** linked invocation 정합 — 회사/링크 상태/부모 스텝 일치(구조 검증 실패 = 검증 불가 child). */
async function linkedInvocationCoherent(
  db: Db,
  runRow: { id: string; companyId: string; parentStepRunId: string | null },
): Promise<boolean> {
  if (!runRow.parentStepRunId) return false;
  const [invocation] = await db
    .select({ id: workflowStepInvocations.id })
    .from(workflowStepInvocations)
    .where(and(
      eq(workflowStepInvocations.childRunId, runRow.id),
      eq(workflowStepInvocations.state, "linked"),
      eq(workflowStepInvocations.companyId, runRow.companyId),
      eq(workflowStepInvocations.parentStepRunId, runRow.parentStepRunId),
    ))
    .limit(1);
  return invocation !== undefined;
}

/** OWNER fresh 평가 — 잠금 하 조인 + OWNER 술어(완전 신원, 자동 전용, DB clock_timestamp 기준). */
async function verifyOwnerFresh(
  db: Db,
  identity: { companyId: string; parentRunId: string; parentStepRunId: string; stepId: string; invocationId: string; generation: number; childRunId: string },
  token: string,
): Promise<boolean> {
  const t = predicateTables();
  const [row] = await db
    .select({ owned: ownerPredicate(t, identityBound(identity), token) })
    .from(t.child)
    .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
    .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
    .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
    .where(and(eq(t.child.id, identity.childRunId), eq(t.invocation.id, identity.invocationId)))
    .limit(1);
  return row?.owned === true;
}

/**
 * 영수증 소비 술어 — BASE_ID+CURRENT+AUTO(완전 신원) + running 자식 + 기존 영수증 없음 +
 * 정확한 토큰/생존 임대·마감(DB 시계). U 의 스텝 행 NOT EXISTS 는 의도적으로 제외한다 —
 * 이 트랜잭션이 방금 삽입했다.
 */
function receiptOwnerPredicate(
  t: ChildStartTables,
  b: WorkflowChildIdentity,
  token: string,
): SQL {
  return sql`(${autoPredicate(t, b)}
    and ${t.child}.status = 'running'
    and ${t.child}.child_start_materialized_at is null
    and ${timeValidPredicate(t, token)})`;
}

function predicateTables(): ChildStartTables {
  return {
    parent: alias(workflowRuns, "pcs_parent") as unknown as typeof workflowRuns,
    invocation: workflowStepInvocations,
    parentStep: workflowStepRuns,
    child: alias(workflowRuns, "pcs_child") as unknown as typeof workflowRuns,
  };
}

/** ChildStartIdentity(number 세대)를 검증된 완전 바운드 B 로 변환한다(진입점이 ===1 을 보장). */
function identityBound(identity: { companyId: string; parentRunId: string; parentStepRunId: string; stepId: string; invocationId: string; generation: number; childRunId: string }): WorkflowChildIdentity {
  return { ...identity, generation: 1 };
}
