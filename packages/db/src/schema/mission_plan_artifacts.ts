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
import { missions } from "./missions.js";

export type MissionPlanArtifactRefPayload = Record<string, unknown>;
export type MissionPlanArtifactJsonArray = Array<Record<string, unknown> | string>;

export const missionPlanArtifacts = pgTable(
  "mission_plan_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("active"),
    ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
    missionGoal: text("mission_goal").notNull(),
    refs: jsonb("refs").$type<MissionPlanArtifactRefPayload>().notNull().default({}),
    assumptions: jsonb("assumptions").$type<MissionPlanArtifactJsonArray>().notNull().default([]),
    requiredInputs: jsonb("required_inputs").$type<MissionPlanArtifactJsonArray>().notNull().default([]),
    successCriteria: jsonb("success_criteria").$type<MissionPlanArtifactJsonArray>().notNull().default([]),
    risks: jsonb("risks").$type<MissionPlanArtifactJsonArray>().notNull().default([]),
    steps: jsonb("steps").$type<MissionPlanArtifactJsonArray>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionRevisionIdx: uniqueIndex("mission_plan_artifacts_mission_revision_idx").on(table.missionId, table.revision),
    activeIdx: index("mission_plan_artifacts_active_idx").on(table.companyId, table.missionId, table.status, table.revision),
    ownerAgentIdIdx: index("mission_plan_artifacts_owner_agent_id_idx").on(table.ownerAgentId),
  }),
);
