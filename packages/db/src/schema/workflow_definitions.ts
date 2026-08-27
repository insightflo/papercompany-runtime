import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { projects } from "./projects.js";
import { missions } from "./missions.js";

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    stepsJson: jsonb("steps_json").$type<unknown[]>().notNull().default([]),
    schedule: text("schedule"),
    timezone: text("timezone"),
    deadlineTime: text("deadline_time"),
    lastScheduledRunAt: timestamp("last_scheduled_run_at", { withTimezone: true }),
    lastScheduleError: text("last_schedule_error"),
    lastScheduleErrorAt: timestamp("last_schedule_error_at", { withTimezone: true }),
    timeoutMinutes: integer("timeout_minutes"),
    maxDailyRuns: integer("max_daily_runs"),
    maxConcurrentRuns: integer("max_concurrent_runs"),
    triggerLabels: jsonb("trigger_labels").$type<string[]>().notNull().default([]),
    labelIds: jsonb("label_ids").$type<string[]>().notNull().default([]),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    // [목적] PAQO 정의 불변성(Stage 3): 정의가 어떤 미션에 귀속되는지 추적.
    // [수정시 영향] PAQO 정의 재사용 판단(회사+미션+해시)이 이 컬럼을 기준으로 한다.
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    // [목적] 정의 내용 해시. Stage 4 해싱 알고리즘 확정 전까지 null 허용(레거시는 null 유지).
    definitionHash: text("definition_hash"),
    createParentIssuePolicy: text("create_parent_issue_policy"),
    executionMode: text("execution_mode"),
    dynamicPlanBootstrapOnly: boolean("dynamic_plan_bootstrap_only").notNull().default(false),
    // [목적] 수동 실행 시 보드에서 수집할 실행 입력 선언({$runMetadata.<key>} 템플릿으로 스텝에 주입).
    // [수정시 영향] UI 실행 폼과 runMetadata 템플릿 치환 키의 원천. 없으면 즉시 실행(기존 동작).
    runInputs: jsonb("run_inputs").$type<unknown[]>().notNull().default([]),
    source: text("source"),
    sourceKind: text("source_kind"),
    legacyPluginEntityId: uuid("legacy_plugin_entity_id"),
    legacyMetadata: jsonb("legacy_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_workflow_definitions_company_id").on(table.companyId),
    statusIdx: index("idx_workflow_definitions_status").on(table.status),
    scheduleIdx: index("idx_workflow_definitions_schedule").on(table.companyId, table.status, table.schedule),
    legacyPluginEntityIdIdx: index("idx_workflow_definitions_legacy_plugin_entity_id").on(
      table.legacyPluginEntityId,
    ),
    paqoIdentityUq: uniqueIndex("workflow_definitions_paqo_identity_uq")
      .on(table.companyId, table.missionId, table.definitionHash)
      .where(
        sql`${table.sourceKind} = 'paqo' AND ${table.missionId} IS NOT NULL AND ${table.definitionHash} IS NOT NULL`,
      ),
  }),
);
