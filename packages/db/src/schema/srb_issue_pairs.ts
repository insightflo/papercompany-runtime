import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { srbLinks } from "./srb_links.js";

export const srbIssuePairs = pgTable(
  "srb_issue_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id").notNull().references(() => srbLinks.id, { onDelete: "cascade" }),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    mirrorCompanyId: uuid("mirror_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    mirrorIssueId: uuid("mirror_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    statusSyncMode: text("status_sync_mode").notNull().default("blocked_only"),
    lastSyncedStatus: text("last_synced_status"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIssueIdx: index("idx_srb_issue_pairs_source_issue_id").on(table.sourceCompanyId, table.sourceIssueId),
    mirrorIssueIdx: index("idx_srb_issue_pairs_mirror_issue_id").on(table.mirrorCompanyId, table.mirrorIssueId),
    uniquePairIdx: uniqueIndex("srb_issue_pairs_unique_pair_idx").on(table.linkId, table.sourceIssueId),
  }),
);
