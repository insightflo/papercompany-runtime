import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  jsonb,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { workflowDefinitions } from "./workflow_definitions.js";
import { workflowRunSlots } from "./workflow_run_slots.js";
import { issues } from "./issues.js";
import { missions } from "./missions.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    dispatchAuthorityVersion: integer("dispatch_authority_version").notNull().default(0),
    originalStatus: text("original_status"),
    triggeredBy: text("triggered_by").notNull(),
    triggerSource: text("trigger_source"),
    runDate: text("run_date"),
    runNumber: integer("run_number"),
    runLabel: text("run_label"),
    parentIssueId: uuid("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
    // workflow→workflow 자식 run 연결(0101, self-FK).
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => workflowRuns.id, { onDelete: "set null" }),
    parentStepRunId: uuid("parent_step_run_id").references(() => workflowStepRuns.id, { onDelete: "set null" }),
    rootRunId: uuid("root_run_id").references((): AnyPgColumn => workflowRuns.id, { onDelete: "set null" }),
    scheduledSlotId: uuid("scheduled_slot_id").references(() => workflowRunSlots.id, { onDelete: "set null" }),
    legacyPluginRunEntityId: uuid("legacy_plugin_run_entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // [fix4 P1-1] 자식 초기화 소유/임대/마감/materialization 영수증 — 내구 실행 권위.
    //   상태/타임스탬프만으로는 실행 권위가 아니다(라운드-4 검증 finding 1/2).
    childStartToken: uuid("child_start_token"),
    childStartLeaseExpiresAt: timestamp("child_start_lease_expires_at", { withTimezone: true }),
    childStartDeadlineAt: timestamp("child_start_deadline_at", { withTimezone: true }),
    childStartMaterializedAt: timestamp("child_start_materialized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // [fix4 P1-1 + cycle B §10] 토큰/임계 만료 쌍 정합 — 자식 시작 임대의 구조 불변식.
    //   실제 drizzle check() 헬퍼로 등록한다(raw sql.as() 는 getTableConfig().checks 에 나타나지
    //   않아 §10 패리티 검증과 drizzle-kit 재생성이 실패했다). 0101 DDL 의미론 동일 보존.
    childStartLeasePairCk: check("workflow_runs_child_start_lease_pair_ck", sql`(${table.childStartToken} is null) = (${table.childStartLeaseExpiresAt} is null)`),
    // [TS하드닝 #1 DB절반 2026-11-09] 0046이 CREATE TABLE 안에 인라인으로 만든
    //   workflow_runs_status_check(pending/running/completed/failed/cancelled)를
    //   스키마에도 명시해 제약-스키마 표류를 해소한다. 값 목록 = 코드가 실제로
    //   workflow_runs.status 에 쓰는 값 ∪ 운영 실측값 대조 확정. 'canceled'/'aborted'/
    //   'timed-out' 은 코드 읽기용 종결집합에만 있고 이 컬럼에 쓰지 않으므로 제외.
    //   새 상태값 추가 시 반드시 마이그레이션과 함께 이 목록을 갱신한다.
    statusCheck: check("workflow_runs_status_check", sql`${table.status} in
    ('pending','running','completed','failed','cancelled')`),
    workflowIdIdx: index("idx_workflow_runs_workflow_id").on(table.workflowId),
    companyIdMissionIdIdx: index("idx_workflow_runs_company_id_mission_id").on(
      table.companyId,
      table.missionId,
    ),
    statusIdx: index("idx_workflow_runs_status").on(table.status),
    triggerSourceIdx: index("idx_workflow_runs_company_trigger_source").on(
      table.companyId,
      table.triggerSource,
    ),
    parentIssueIdIdx: index("idx_workflow_runs_parent_issue_id").on(table.parentIssueId),
    parentRunIdIdx: index("idx_workflow_runs_parent_run_id").on(table.parentRunId),
    parentStepRunIdIdx: index("idx_workflow_runs_parent_step_run_id").on(table.parentStepRunId),
    rootRunIdIdx: index("idx_workflow_runs_root_run_id").on(table.rootRunId),
    legacyPluginRunEntityIdIdx: index("idx_workflow_runs_legacy_plugin_run_entity_id").on(
      table.legacyPluginRunEntityId,
    ),
    scheduledSlotIdUq: uniqueIndex("workflow_runs_scheduled_slot_id_uq").on(table.scheduledSlotId),
  }),
);
