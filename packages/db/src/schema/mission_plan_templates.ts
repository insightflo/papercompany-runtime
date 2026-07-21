import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const missionPlanTemplates = pgTable(
  "mission_plan_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    selectionDescription: text("selection_description").notNull(),
    instructions: text("instructions").notNull(),
    origin: text("origin").notNull().default("custom"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("mission_plan_templates_company_key_uq").on(table.companyId, table.key),
    companyIdx: index("mission_plan_templates_company_idx").on(table.companyId),
  }),
);
