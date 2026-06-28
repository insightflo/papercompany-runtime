import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { evaluatorAnchorCases } from "./evaluator_anchor_cases.js";
import { evaluatorVersions } from "./evaluator_versions.js";
import { qualityReviewItems } from "./quality_review_items.js";

export const evaluatorCandidateRuns = pgTable(
  "evaluator_candidate_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    evaluatorVersionId: uuid("evaluator_version_id").notNull().references(() => evaluatorVersions.id, { onDelete: "cascade" }),
    anchorCaseId: uuid("anchor_case_id").references(() => evaluatorAnchorCases.id, { onDelete: "set null" }),
    reviewItemId: uuid("review_item_id").references(() => qualityReviewItems.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    replayInput: jsonb("replay_input").$type<Record<string, unknown>>().notNull().default({}),
    replayResult: jsonb("replay_result").$type<Record<string, unknown>>().notNull().default({}),
    coverageSummary: jsonb("coverage_summary").$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("evaluator_candidate_runs_company_status_idx").on(table.companyId, table.status, table.createdAt),
    evaluatorIdx: index("evaluator_candidate_runs_evaluator_idx").on(table.evaluatorVersionId, table.status),
    anchorIdx: index("evaluator_candidate_runs_anchor_idx").on(table.anchorCaseId),
    reviewItemIdx: index("evaluator_candidate_runs_review_item_idx").on(table.reviewItemId),
  }),
);
