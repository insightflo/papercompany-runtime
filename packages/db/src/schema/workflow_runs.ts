import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowDefinitions } from "./workflow_definitions.js";
import { missions } from "./missions.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    triggeredBy: text("triggered_by").notNull(),
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
  }),
);
