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
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export type MissionAgentRuntimeStateJson = {
  runtimeKey?: string;
  bootstrapContextInjected?: boolean;
  bootstrapContextInjectedAt?: string | null;
  lastIssueEnvelopeAt?: string | null;
  workspaceKey?: string | null;
  stopReason?: string | null;
  processTermination?: Array<{ id: string; attempted: boolean; error?: string }>;
};

export const missionAgentRuntimes = pgTable(
  "mission_agent_runtimes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    runtimeKey: text("runtime_key").notNull(),
    status: text("status").notNull().default("idle"),
    processPid: integer("process_pid"),
    sessionId: text("session_id"),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    workspaceId: uuid("workspace_id"),
    workspaceKey: text("workspace_key").notNull().default("default"),
    currentIssueId: uuid("current_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastRunStatus: text("last_run_status"),
    queueDepth: integer("queue_depth").notNull().default(0),
    runCount: integer("run_count").notNull().default(0),
    contextBootstrapVersion: integer("context_bootstrap_version").notNull().default(1),
    contextInjectedAt: timestamp("context_injected_at", { withTimezone: true }),
    lastIssueEnvelopeAt: timestamp("last_issue_envelope_at", { withTimezone: true }),
    stateJson: jsonb("state_json").$type<MissionAgentRuntimeStateJson>().notNull().default({}),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    stopReason: text("stop_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runtimeUniqueIdx: uniqueIndex("mission_agent_runtimes_mission_agent_adapter_workspace_key").on(
      table.missionId,
      table.agentId,
      table.adapterType,
      table.workspaceKey,
    ),
    companyStatusIdx: index("idx_mission_agent_runtimes_company_status").on(table.companyId, table.status),
    missionStatusIdx: index("idx_mission_agent_runtimes_mission_status").on(table.companyId, table.missionId, table.status),
    agentIdx: index("idx_mission_agent_runtimes_agent").on(table.agentId),
  }),
);
