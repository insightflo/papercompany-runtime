import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { qualityPolicyVersions } from "./quality_policy_versions.js";

export const qualityPolicyUsage = pgTable("quality_policy_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  policyVersionId: uuid("policy_version_id").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  reservedCostCents: integer("reserved_cost_cents").notNull().default(0),
  chargedCostCents: integer("charged_cost_cents").notNull().default(0),
  executionAttempts: integer("execution_attempts").notNull().default(0),
  revision: integer("revision").notNull().default(1),
}, (table) => ({
  windowUq: uniqueIndex("quality_policy_usage_company_policy_window_uq").on(table.companyId, table.policyVersionId, table.windowStart),
  policyFk: foreignKey({ columns: [table.companyId, table.policyVersionId], foreignColumns: [qualityPolicyVersions.companyId, qualityPolicyVersions.id] }),
  windowCheck: check("quality_policy_usage_window_check", sql`${table.windowEnd} > ${table.windowStart}`),
  countersCheck: check("quality_policy_usage_counters_check", sql`${table.reservedCostCents} >= 0 and ${table.chargedCostCents} >= 0 and ${table.executionAttempts} >= 0 and ${table.revision} >= 1`),
}));
