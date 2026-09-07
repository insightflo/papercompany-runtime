import {
  boolean,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

/**
 * workflow_step_invocations — workflow→workflow 자식 실행 영수증 (additive, 0101).
 *
 * parent_step_run_id UNIQUE: 자식 run 생성의 멱등 클레임. 동시/재진입 dispatch 에서도
 * step-run 시도당 1행만 성립하고, conflict 시 기존 자식을 재사용한다(크래시 복구 의미론).
 * generation: policy-retry 가 새 세대(stepRun.retryCount+1)로 CAS 갱신 — 회복 경로는
 * 기존 세대를 재사용한다. child_run_id NULL 허용(fix round 2): NULL 의 의미는 state 로 구분한다 —
 * state='claimed' + NULL 은 클레임 후 자식 생성 전 크래시(re-dispatch 대상),
 * state='linked' + NULL 은 링크됐던 자식이 삭제됨(FK set null tombstone → fenced
 * child_run_failed 정산 대상). 클레임+자식 생성+링크는 단일 트랜잭션으로 원자 커밋된다.
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
    /** 클레임 수명 주기: 'claimed'(자식 미생성) -> 'linked'(자식 링크 완료). 자식 삭제 시
     *  FK set null 로 childRunId 가 NULL 이 되지만 state='linked' 가 유지되어 tombstone 판별.
     */
    state: text("state").notNull().default("claimed"),
    /** [fix3 P1-1] 요청된 wait 모드의 내구 기록 — 회복은 이 값을 사용한다(하드코딩 금지).
     *  cap(admission) 도 이 컬럼 기준으로 커밋된 요청을 센다.
     */
    wait: boolean("wait").notNull().default(true),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentStepRunIdUq: uniqueIndex("workflow_step_invocations_parent_step_run_id_uq").on(
      table.parentStepRunId,
    ),
    companyIdIdx: index("idx_workflow_step_invocations_company_id").on(table.companyId),
    childRunIdIdx: index("idx_workflow_step_invocations_child_run_id").on(table.childRunId),
  }),
);
