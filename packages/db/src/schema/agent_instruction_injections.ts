import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export type AgentInstructionInjectionJson = {
  entryPath: string;
  includedPaths: string[];
  deferredPaths: string[];
  warnings: string[];
  contentHash: string;
};

export const agentInstructionInjections = pgTable(
  "agent_instruction_injections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    instructionsPath: text("instructions_path").notNull(),
    contentHash: text("content_hash").notNull(),
    injectionCount: integer("injection_count").notNull().default(1),
    lastInjectionJson: jsonb("last_injection_json").$type<AgentInstructionInjectionJson>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueAgentPathUnique: uniqueIndex("agent_instruction_injections_issue_agent_path_uq").on(
      table.companyId,
      table.issueId,
      table.agentId,
      table.adapterType,
      table.instructionsPath,
    ),
    issueUpdatedIdx: index("idx_agent_instruction_injections_issue_updated").on(table.companyId, table.issueId, table.updatedAt),
    contentHashIdx: index("idx_agent_instruction_injections_content_hash").on(table.contentHash),
  }),
);
