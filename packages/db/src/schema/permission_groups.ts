import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Company-scoped permission group. The group is a grant target (principalType='group');
// grant rows live in principal_permission_grants (no separate grants table).
// name is unique per company; status active|suspended (suspended group grants are ineffective).
export const permissionGroups = pgTable(
  "permission_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUniqueIdx: uniqueIndex("permission_groups_company_name_unique_idx").on(
      table.companyId,
      table.name,
    ),
    companyStatusIdx: index("permission_groups_company_status_idx").on(table.companyId, table.status),
  }),
);
