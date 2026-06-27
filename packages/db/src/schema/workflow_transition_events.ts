import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { missions } from "./missions.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

export const workflowTransitionEvents = pgTable(
  "workflow_transition_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, { onDelete: "cascade" }),
    workflowStepRunId: uuid("workflow_step_run_id").references(() => workflowStepRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    layer: text("layer").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    decision: text("decision"),
    verdict: text("verdict"),
    reason: text("reason"),
    reasonCode: text("reason_code"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowRunEventIdx: index("workflow_transition_events_workflow_run_event_idx")
      .on(table.companyId, table.workflowRunId, table.eventType, table.createdAt),
    missionEventIdx: index("workflow_transition_events_mission_event_idx")
      .on(table.companyId, table.missionId, table.createdAt),
    wakeupEventIdx: index("workflow_transition_events_wakeup_event_idx")
      .on(table.wakeupRequestId, table.eventType),
    heartbeatRunEventIdx: index("workflow_transition_events_heartbeat_run_event_idx")
      .on(table.heartbeatRunId, table.eventType),
    correlationIdx: index("workflow_transition_events_correlation_idx")
      .on(table.companyId, table.correlationId, table.createdAt),
    // [Task 1D Step 5] partial unique index for event idempotency — prevents duplicate
    // transition events with the same (company_id, idempotency_key) when key is non-null.
    idempotencyKeyUq: uniqueIndex("workflow_transition_events_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  }),
);
