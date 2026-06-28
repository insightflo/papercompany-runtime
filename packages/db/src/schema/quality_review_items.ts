import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";

export const qualityReviewItems = pgTable(
  "quality_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("detected"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    triggerSource: text("trigger_source").notNull(),
    triggerMetadata: jsonb("trigger_metadata").$type<Record<string, unknown>>().notNull().default({}),
    failureType: text("failure_type"),
    priority: text("priority").notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("quality_review_items_company_status_idx").on(table.companyId, table.status, table.createdAt),
    companyTriggerIdx: index("quality_review_items_company_trigger_idx").on(table.companyId, table.triggerSource, table.createdAt),
    missionIdx: index("quality_review_items_company_mission_idx").on(table.companyId, table.missionId, table.createdAt),
  }),
);
