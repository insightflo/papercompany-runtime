import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missionQualityVerdicts } from "./mission_quality_verdicts.js";
import { missions } from "./missions.js";
import { qualityReviewItems } from "./quality_review_items.js";

export const evaluatorAnchorCases = pgTable(
  "evaluator_anchor_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceVerdictId: uuid("source_verdict_id").notNull().references(() => missionQualityVerdicts.id, { onDelete: "cascade" }),
    reviewItemId: uuid("review_item_id").notNull().references(() => qualityReviewItems.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    failureType: text("failure_type"),
    verdict: text("verdict").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<Array<Record<string, unknown>>>().notNull().default([]),
    status: text("status").notNull().default("candidate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("evaluator_anchor_cases_company_status_idx").on(table.companyId, table.status, table.createdAt),
    reviewItemIdx: index("evaluator_anchor_cases_review_item_idx").on(table.reviewItemId),
    sourceVerdictIdx: index("evaluator_anchor_cases_source_verdict_idx").on(table.sourceVerdictId),
  }),
);
