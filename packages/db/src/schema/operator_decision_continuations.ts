import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { operatorDecisions } from "./operator_decisions.js";

export const operatorDecisionContinuations = pgTable(
  "operator_decision_continuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    operatorDecisionId: uuid("operator_decision_id").notNull().references(() => operatorDecisions.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    state: text("state").notNull().default("pending"),
    generation: integer("generation").notNull().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    manualRetryCount: integer("manual_retry_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionUq: uniqueIndex("operator_decision_continuations_decision_uq").on(table.operatorDecisionId),
    claimIdx: index("operator_decision_continuations_claim_idx")
      .on(table.state, table.nextAttemptAt, table.leaseExpiresAt),
    companyStateUpdatedIdx: index("operator_decision_continuations_company_state_updated_idx")
      .on(table.companyId, table.state, table.updatedAt),
    companyKeyUq: uniqueIndex("operator_decision_continuations_company_key_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    stateCheck: check(
      "operator_decision_continuations_state_check",
      sql`${table.state} in ('pending', 'leased', 'accepted', 'blocked', 'exhausted')`,
    ),
    generationCheck: check(
      "operator_decision_continuations_generation_check",
      sql`${table.generation} between 1 and 3 and ${table.manualRetryCount} between 0 and 2 and ${table.generation} = ${table.manualRetryCount} + 1`,
    ),
    attemptCheck: check(
      "operator_decision_continuations_attempt_check",
      sql`${table.attemptCount} between 0 and 3 and ${table.maxAttempts} = 3`,
    ),
    leaseCheck: check(
      "operator_decision_continuations_lease_check",
      sql`(${table.state} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'leased' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    acceptedCheck: check(
      "operator_decision_continuations_accepted_check",
      sql`${table.state} <> 'accepted' or (${table.wakeupRequestId} is not null and ${table.idempotencyKey} is not null and ${table.acceptedAt} is not null)`,
    ),
  }),
);
