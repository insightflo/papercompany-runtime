import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

export const workflowDelegations = pgTable(
  "workflow_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceWorkflowRunId: uuid("source_workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    sourceWorkflowStepRunId: uuid("source_workflow_step_run_id").notNull().references(() => workflowStepRuns.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceStepRunUniqueIdx: uniqueIndex("workflow_delegations_source_step_run_uq").on(table.sourceWorkflowStepRunId),
    targetIssueUniqueIdx: uniqueIndex("workflow_delegations_target_issue_uq").on(table.targetIssueId),
    sourceCompanyStatusIdx: index("workflow_delegations_source_company_status_idx").on(table.sourceCompanyId, table.status),
    targetCompanyIssueIdx: index("workflow_delegations_target_company_issue_idx").on(table.targetCompanyId, table.targetIssueId),
  }),
);
