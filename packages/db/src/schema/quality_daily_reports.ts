import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { evaluatorCandidateRuns } from "./evaluator_candidate_runs.js";
import { issues } from "./issues.js";

export const qualityDailyReports = pgTable(
  "quality_daily_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reportDate: text("report_date").notNull(),
    status: text("status").notNull().default("generated"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    sourceEvaluatorRunId: uuid("source_evaluator_run_id").references(() => evaluatorCandidateRuns.id, { onDelete: "set null" }),
    improvementIssueId: uuid("improvement_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDateIdx: index("quality_daily_reports_company_date_idx").on(table.companyId, table.reportDate),
    companyStatusIdx: index("quality_daily_reports_company_status_idx").on(table.companyId, table.status, table.createdAt),
    evaluatorRunIdx: index("quality_daily_reports_evaluator_run_idx").on(table.sourceEvaluatorRunId),
  }),
);
