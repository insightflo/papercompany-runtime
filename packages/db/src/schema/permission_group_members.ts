import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { permissionGroups } from "./permission_groups.js";

// User members of a permission group. user -> group expansion only; separate from company_memberships (user/agent).
// status active|suspended; a suspended member does not inherit the group's grants.
// groupId must reference a permission_groups row in the same company (access service enforces scope).
export const permissionGroupMembers = pgTable(
  "permission_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    groupId: uuid("group_id").notNull().references(() => permissionGroups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyGroupUserUniqueIdx: uniqueIndex("permission_group_members_company_group_user_unique_idx").on(
      table.companyId,
      table.groupId,
      table.userId,
    ),
    companyUserStatusIdx: index("permission_group_members_company_user_status_idx").on(
      table.companyId,
      table.userId,
      table.status,
    ),
  }),
);
