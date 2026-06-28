import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { qualityReviewItems } from "./quality_review_items.js";

export const missionQualityVerdicts = pgTable(
  "mission_quality_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewItemId: uuid("review_item_id").notNull().references(() => qualityReviewItems.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    verdict: text("verdict").notNull(),
    failureType: text("failure_type"),
    reason: text("reason"),
    decidedByUserId: text("decided_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewItemIdx: index("mission_quality_verdicts_review_item_idx").on(table.reviewItemId, table.createdAt),
    companyVerdictIdx: index("mission_quality_verdicts_company_verdict_idx").on(table.companyId, table.verdict, table.createdAt),
    missionIdx: index("mission_quality_verdicts_company_mission_idx").on(table.companyId, table.missionId, table.createdAt),
  }),
);
