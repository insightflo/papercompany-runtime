import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

/**
 * workflow_step_invocations — workflow→workflow 자식 실행 영수증 (0101, descope v1).
 *
 * parent_step_run_id UNIQUE: 자식 run 생성의 멱등 클레임. 동시/재진입 dispatch 에서도
 * step-run 시도당 1행만 성립하고, conflict 시 기존 자식을 재사용한다(크래시 복구 의미론).
 * generation: descope v1 에서 항상 1(CHECK 강제) — 재시도 세대/교체는 존재하지 않고,
 * 세대 일치는 신원 검증으로만 사용된다. child_run_id NULL 허용: NULL 의 의미는 state 로
 * 구분한다 — state='claimed' + NULL 은 클레임 트랜잭션 내부의 일시 구성 상태일 뿐이고
 * (커밋 시 deferred 트리거가 linked 강제 — 커밋된 claimed 행은 기계적으로 불가능),
 * state='linked' + NULL 은 링크됐던 자식이 삭제된 tombstone(FK set null → fenced
 * child_run_failed 정산 대상, 재생성 금지). 클레임+자식 생성+링크는 단일 트랜잭션으로
 * 원자 커밋된다. wait 컬럼 없음(descope D1: wait:true only).
 */
export const workflowStepInvocations = pgTable(
  "workflow_step_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    parentStepRunId: uuid("parent_step_run_id")
      .notNull()
      .references(() => workflowStepRuns.id, { onDelete: "cascade" }),
    childRunId: uuid("child_run_id")
      .references(() => workflowRuns.id, { onDelete: "set null" }),
    /** 클레임 수명 주기: 'claimed'(자식 미생성, tx-local) -> 'linked'(자식 링크 완료).
     *  자식 삭제 시 FK set null 로 childRunId 가 NULL 이 되지만 state='linked' 가 유지되어
     *  tombstone 판별. CHECK 제약으로 claimed/linked 외 상태는 불가능하다.
     */
    state: text("state").notNull().default("claimed"),
    /** [descope v1 D2] 세대 교체 없음 — 항상 1. 재사용/변이 전 신원 검증으로만 읽는다. */
    generation: integer("generation").notNull().default(1),
    /** [r8 finding 1] 보존된 대상 정의 신원 — 자식 삭제 후에도 이력 유지(FK 아님; 완전 정산
     *  후 정의 삭제를 막지 않는다). 0101 immutable 트리거가 갱신을 거부한다. */
    targetWorkflowId: uuid("target_workflow_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentStepRunIdUq: uniqueIndex("workflow_step_invocations_parent_step_run_id_uq").on(
      table.parentStepRunId,
    ),
    // [descope v1] 비 NULL child_run_id 유일 — 두 invocation 이 같은 자식을 공유하지 못한다.
    childRunIdUq: uniqueIndex("workflow_step_invocations_child_run_id_uq")
      .on(table.childRunId)
      .where(sql`child_run_id is not null`),
    companyIdIdx: index("idx_workflow_step_invocations_company_id").on(table.companyId),
    childRunIdIdx: index("idx_workflow_step_invocations_child_run_id").on(table.childRunId),
    targetWorkflowIdIdx: index("idx_workflow_step_invocations_target_workflow_id").on(table.targetWorkflowId),
    // [descope v1] 상태 기계 CHECK — SQL 0101 과 동일 의미(마이그레이션/Drizzle 패리티 검증 대상).
    stateCk: check(
      "workflow_step_invocations_state_ck",
      sql`${table.state} in ('claimed', 'linked')`,
    ),
    generationOneCk: check(
      "workflow_step_invocations_generation_one_ck",
      sql`${table.generation} = 1`,
    ),
  }),
);
