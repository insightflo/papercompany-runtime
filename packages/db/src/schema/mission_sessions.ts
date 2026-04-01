import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { missions } from "./missions.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const missionSessions = pgTable(
  "mission_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sessionSecretId: uuid("session_secret_id").notNull().references(() => companySecrets.id),
    adapterType: text("adapter_type").notNull(),
    status: text("status").notNull().default("active"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    runCount: integer("run_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionIdIdx: index("idx_mission_sessions_mission_id").on(table.missionId),
    companyIdStatusIdx: index("idx_mission_sessions_company_id_status").on(table.companyId, table.status),
    agentIdIdx: index("idx_mission_sessions_agent_id").on(table.agentId),
    uniqueIdx: uniqueIndex("mission_sessions_mission_id_agent_id_adapter_type_key").on(
      table.missionId,
      table.agentId,
      table.adapterType,
    ),
  }),
);
