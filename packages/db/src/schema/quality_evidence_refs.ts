import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { qualityReviewItems } from "./quality_review_items.js";

export const qualityEvidenceRefs = pgTable(
  "quality_evidence_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewItemId: uuid("review_item_id").notNull().references(() => qualityReviewItems.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    expected: jsonb("expected").$type<Record<string, unknown>>().notNull().default({}),
    actual: jsonb("actual").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("missing"),
    collectedByActorType: text("collected_by_actor_type"),
    collectedByActorId: text("collected_by_actor_id"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceUrl: text("source_url"),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    freshnessExpiresAt: timestamp("freshness_expires_at", { withTimezone: true }),
    blocking: boolean("blocking").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewItemIdx: index("quality_evidence_refs_review_item_idx").on(table.reviewItemId, table.surface),
    companyStatusIdx: index("quality_evidence_refs_company_status_idx").on(table.companyId, table.status, table.surface),
  }),
);
