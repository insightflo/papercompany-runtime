import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentQueueAdmissionJobs = pgTable(
  "agent_queue_admission_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state").notNull().default("pending"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("agent_queue_admission_jobs_agent_id_idx").on(table.agentId),
    heartbeatRunIdIdx: index("agent_queue_admission_jobs_heartbeat_run_id_idx").on(table.heartbeatRunId),
    claimIdx: index("agent_queue_admission_jobs_claim_idx")
      .on(table.state, table.nextAttemptAt, table.leaseExpiresAt)
      .where(sql`${table.state} in ('pending', 'leased')`),
    dedupeKeyUq: uniqueIndex("agent_queue_admission_jobs_dedupe_key_uq").on(table.dedupeKey),
  }),
);
