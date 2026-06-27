import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    // [AREA: structured-events Task 1C] typed queue columns — payload JSON 의존 축소.
    // FK references omitted to avoid circular import (heartbeat_runs → agent_wakeup_requests → issues/workflow_runs → heartbeat_runs).
    requestKind: text("request_kind"),
    issueId: uuid("issue_id"),
    missionId: uuid("mission_id"),
    workflowRunId: uuid("workflow_run_id"),
    workflowStepRunId: uuid("workflow_step_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    // [Task 1C] typed-column indexes for queue queries without JSONB ops.
    requestKindIdx: index("agent_wakeup_requests_request_kind_idx").on(table.companyId, table.requestKind, table.status),
    issueStatusIdx: index("agent_wakeup_requests_issue_status_idx").on(table.issueId, table.status),
    missionStatusIdx: index("agent_wakeup_requests_mission_status_idx").on(table.companyId, table.missionId, table.status),
    workflowStepStatusIdx: index("agent_wakeup_requests_workflow_step_status_idx").on(table.workflowStepRunId, table.status),
  }),
);
