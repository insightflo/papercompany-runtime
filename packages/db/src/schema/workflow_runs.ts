import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowDefinitions } from "./workflow_definitions.js";
import { workflowRunSlots } from "./workflow_run_slots.js";
import { issues } from "./issues.js";
import { missions } from "./missions.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    originalStatus: text("original_status"),
    triggeredBy: text("triggered_by").notNull(),
    triggerSource: text("trigger_source"),
    runDate: text("run_date"),
    runNumber: integer("run_number"),
    runLabel: text("run_label"),
    parentIssueId: uuid("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
    scheduledSlotId: uuid("scheduled_slot_id").references(() => workflowRunSlots.id, { onDelete: "set null" }),
    legacyPluginRunEntityId: uuid("legacy_plugin_run_entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
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
    legacyPluginRunEntityIdIdx: index("idx_workflow_runs_legacy_plugin_run_entity_id").on(
      table.legacyPluginRunEntityId,
    ),
    scheduledSlotIdUq: uniqueIndex("workflow_runs_scheduled_slot_id_uq").on(table.scheduledSlotId),
  }),
);
