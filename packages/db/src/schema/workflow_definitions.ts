import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { projects } from "./projects.js";

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
    createParentIssuePolicy: text("create_parent_issue_policy"),
    executionMode: text("execution_mode"),
    dynamicPlanBootstrapOnly: boolean("dynamic_plan_bootstrap_only").notNull().default(false),
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
  }),
);
