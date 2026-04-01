import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { missions } from "./missions.js";
import { agents } from "./agents.js";

export const missionAgents = pgTable(
  "mission_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("executor"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionIdIdx: index("idx_mission_agents_mission_id").on(table.missionId),
    agentIdIdx: index("idx_mission_agents_agent_id").on(table.agentId),
    uniqueIdx: uniqueIndex("mission_agents_mission_id_agent_id_key").on(table.missionId, table.agentId),
  }),
);
