import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowDefinitions } from "./workflow_definitions.js";

export const workflowRunSlots = pgTable(
  "workflow_run_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowDefinitionId: uuid("workflow_definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    triggerSource: text("trigger_source").notNull().default("schedule"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    runDate: text("run_date"),
    timezone: text("timezone"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("claimed"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    workflowTriggerScheduledAtUq: uniqueIndex("workflow_run_slots_workflow_trigger_scheduled_at_uq").on(
      table.workflowDefinitionId,
      table.triggerSource,
      table.scheduledAt,
    ),
    companyTriggerScheduledAtIdx: index("idx_workflow_run_slots_company_trigger_scheduled_at").on(
      table.companyId,
      table.triggerSource,
      table.scheduledAt,
    ),
    workflowStatusIdx: index("idx_workflow_run_slots_workflow_status").on(
      table.workflowDefinitionId,
      table.status,
    ),
  }),
);
