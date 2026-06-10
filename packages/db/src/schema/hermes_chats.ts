import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const hermesChatSessions = pgTable(
  "hermes_chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: text("created_by_user_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("hermes_chat_sessions_company_updated_idx").on(table.companyId, table.updatedAt),
    companyStatusUpdatedIdx: index("hermes_chat_sessions_company_status_updated_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const hermesChatMessages = pgTable(
  "hermes_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => hermesChatSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("sent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("hermes_chat_messages_session_created_idx").on(table.sessionId, table.createdAt),
    companyCreatedIdx: index("hermes_chat_messages_company_created_idx").on(table.companyId, table.createdAt),
    runIdx: index("hermes_chat_messages_run_idx").on(table.runId),
  }),
);
