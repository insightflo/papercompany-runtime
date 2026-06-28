import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { evaluatorAnchorCases } from "./evaluator_anchor_cases.js";

export const evaluatorVersions = pgTable(
  "evaluator_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    evaluatorType: text("evaluator_type").notNull().default("quality_gate"),
    status: text("status").notNull().default("candidate"),
    sourceAnchorCaseId: uuid("source_anchor_case_id").references(() => evaluatorAnchorCases.id, { onDelete: "set null" }),
    promptPatch: text("prompt_patch"),
    coverageSummary: jsonb("coverage_summary").$type<Record<string, unknown>>().notNull().default({}),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("evaluator_versions_company_status_idx").on(table.companyId, table.status, table.createdAt),
    companyTypeIdx: index("evaluator_versions_company_type_idx").on(table.companyId, table.evaluatorType, table.status),
    sourceAnchorIdx: index("evaluator_versions_source_anchor_idx").on(table.sourceAnchorCaseId),
  }),
);
