import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunFinalizations = pgTable(
  "heartbeat_run_finalizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    executionEpoch: integer("execution_epoch").notNull(),
    executionToken: uuid("execution_token").notNull(),
    terminalOutcome: text("terminal_outcome").notNull(),
    terminalDecisionSource: text("terminal_decision_source").notNull(),
    finalizationVersion: integer("finalization_version").notNull(),
    state: text("state").notNull().default("pending"),
    finalizerLeaseEpoch: integer("finalizer_lease_epoch").notNull().default(0),
    finalizerLeaseToken: uuid("finalizer_lease_token"),
    finalizerOwner: text("finalizer_owner"),
    finalizerLeaseExpiresAt: timestamp("finalizer_lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunIdIdx: index("heartbeat_run_finalizations_heartbeat_run_id_idx").on(table.heartbeatRunId),
    heartbeatRunIdUq: uniqueIndex("heartbeat_run_finalizations_heartbeat_run_id_uniq").on(table.heartbeatRunId),
    claimIdx: index("heartbeat_run_finalizations_claim_idx")
      .on(table.companyId, table.state, table.finalizerLeaseExpiresAt)
      .where(sql`${table.state} in ('pending', 'leased')`),
  }),
);
