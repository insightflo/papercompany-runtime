import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

// 산출물 참조를 소비 스텝 실행 단위로 고정한다. 소비 시점의 "현재 대표" 재해석을
// 허용하면 재시도·회복 중 원본 결과가 바뀔 수 있으므로, 같은 참조는 정확히 한 번 핀한다.
export const workflowStepOutputBindings = pgTable(
  "workflow_step_output_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    consumerStepRunId: uuid("consumer_step_run_id").notNull().references(() => workflowStepRuns.id, { onDelete: "cascade" }),
    referencedStepId: text("referenced_step_id").notNull(),
    // [봇 bug·high 교정] 이슈/회사 삭제 cascade 로 산출물이 지워질 때 바인딩도 함께 지운다 —
    //   no action 이면 상위 삭제 트랜잭션이 FK 위반 500 으로 실패한다(개별 삭제는 서비스 409 가드).
    workProductId: uuid("work_product_id").notNull().references(() => issueWorkProducts.id, { onDelete: "cascade" }),
    sourceExecutionGeneration: integer("source_execution_generation"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stepReferencePinUq: uniqueIndex("workflow_step_output_bindings_step_reference_uq").on(
      table.companyId,
      table.workflowRunId,
      table.consumerStepRunId,
      table.referencedStepId,
    ),
    // [봇 지적 교정] FK 컬럼 인덱스 — 부모 삭제 시 RI 전체스캔 방지(Postgres 는 FK 를 자동 인덱싱하지 않는다).
    workProductIdx: index("workflow_step_output_bindings_work_product_idx").on(
      table.workProductId,
    ),
    // [봇 지적] 나머지 FK 도 RI 체크/단독 조회용 단일 컬럼 인덱스가 필요하다
    //   (유니크 인덱스 선두가 company_id 라 run 단독 조건에 못 쓰인다).
    workflowRunIdx: index("workflow_step_output_bindings_workflow_run_idx").on(
      table.workflowRunId,
    ),
    consumerStepRunIdx: index("workflow_step_output_bindings_consumer_step_run_idx").on(
      table.consumerStepRunId,
    ),
  }),
);
