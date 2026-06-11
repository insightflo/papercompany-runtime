import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { workflowRuns } from "./workflow_runs.js";
import { issues } from "./issues.js";

export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    originalStatus: text("original_status"),
    agentName: text("agent_name"),
    retryCount: integer("retry_count").notNull().default(0),
    sessionId: text("session_id"),
    lastDispatchAttemptAt: timestamp("last_dispatch_attempt_at", { withTimezone: true }),
    lastDispatchAcceptedAt: timestamp("last_dispatch_accepted_at", { withTimezone: true }),
    lastDispatchErrorAt: timestamp("last_dispatch_error_at", { withTimezone: true }),
    lastDispatchErrorSummary: text("last_dispatch_error_summary"),
    lastDispatchRequestId: text("last_dispatch_request_id"),
    legacyPluginStepEntityId: uuid("legacy_plugin_step_entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    workflowRunIdIdx: index("idx_workflow_step_runs_workflow_run_id").on(table.workflowRunId),
    issueIdIdx: index("idx_workflow_step_runs_issue_id").on(table.issueId),
    legacyPluginStepEntityIdIdx: index("idx_workflow_step_runs_legacy_plugin_step_entity_id").on(
      table.legacyPluginStepEntityId,
    ),
  }),
);
