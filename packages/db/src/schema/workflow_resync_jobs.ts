import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

export const workflowResyncJobs = pgTable(
  "workflow_resync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
    workflowStepRunId: uuid("workflow_step_run_id").references(() => workflowStepRuns.id),
    executionGeneration: integer("execution_generation").notNull(),
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
    workflowRunIdIdx: index("workflow_resync_jobs_workflow_run_id_idx").on(table.workflowRunId),
    workflowStepRunIdIdx: index("workflow_resync_jobs_workflow_step_run_id_idx").on(table.workflowStepRunId),
    claimIdx: index("workflow_resync_jobs_claim_idx")
      .on(table.state, table.nextAttemptAt, table.leaseExpiresAt)
      .where(sql`${table.state} in ('pending', 'leased')`),
    dedupeKeyUq: uniqueIndex("workflow_resync_jobs_dedupe_key_uq").on(table.dedupeKey),
  }),
);
