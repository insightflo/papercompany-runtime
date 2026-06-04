import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export type MissionRollingStateJson = {
  missionGoal?: string | null;
  currentPlan?: string | null;
  completedIssues?: Array<{ issueId: string; summary: string; handoffId?: string }>;
  activeDecisions?: string[];
  knownConstraints?: string[];
  openQuestions?: string[];
  blockers?: string[];
  nextRecommendedIssue?: string | null;
  handoffIndex?: Array<{ issueId: string | null; handoffId: string; status: string; createdAt: string }>;
};

export const missionRollingState = pgTable(
  "mission_rolling_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("active"),
    stateMarkdown: text("state_markdown").notNull().default(""),
    stateJson: jsonb("state_json").$type<MissionRollingStateJson>().notNull().default({}),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastCompactedAt: timestamp("last_compacted_at", { withTimezone: true }),
    totalRuns: integer("total_runs").notNull().default(0),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionUniqueIdx: uniqueIndex("mission_rolling_state_mission_id_key").on(table.missionId),
    companyStatusIdx: index("idx_mission_rolling_state_company_status").on(table.companyId, table.status),
    companyUpdatedIdx: index("idx_mission_rolling_state_company_updated").on(table.companyId, table.updatedAt),
  }),
);
