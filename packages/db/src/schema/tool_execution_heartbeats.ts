import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { ToolProgressPolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { toolDefinitions } from "./tool_definitions.js";

export const toolExecutionHeartbeats = pgTable("tool_execution_heartbeats", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  toolId: uuid("tool_id").notNull().references(() => toolDefinitions.id),
  requestId: text("request_id").notNull(),
  adapterType: text("adapter_type").notNull(),
  policy: jsonb("policy").$type<ToolProgressPolicy>().notNull(),
  tokenHash: text("token_hash"),
  // Immutable diagnostic bindings survive deletion of a parent; consumers fail closed.
  workflowRunId: uuid("workflow_run_id"), stepRunId: uuid("step_run_id"), stepId: text("step_id"),
  executionGeneration: integer("execution_generation"), retryCount: integer("retry_count"), iterationIndex: integer("iteration_index"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true }).notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
  stageIndex: integer("stage_index").notNull().default(-1),
  current: bigint("current", { mode: "number" }).notNull().default(0),
  total: bigint("total", { mode: "number" }),
  state: text("state").$type<"active" | "succeeded" | "failed" | "timed_out">().notNull().default("active"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  reason: varchar("reason", { length: 64 }),
}, (t) => ({
  companyExecution: uniqueIndex("tool_execution_heartbeats_company_execution_uq").on(t.companyId, t.id),
  companyStarted: index("tool_execution_heartbeats_company_started_idx").on(t.companyId, t.startedAt),
  activeExpiry: index("tool_execution_heartbeats_active_expiry_idx").on(t.lastProgressAt, t.startedAt).where(sql`${t.state} = 'active'`),
  stateCheck: check("tool_execution_heartbeats_state_ck", sql`${t.state} in ('active','succeeded','failed','timed_out')`),
}));
