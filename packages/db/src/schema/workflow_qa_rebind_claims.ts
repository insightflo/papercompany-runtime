import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";
import { workflowRecoveryAuthorities } from "./workflow_recovery_authorities.js";

/** Observation and future one-shot claim share a stable bundle key. Stage A never claims. */
export const workflowQaRebindClaims = pgTable("workflow_qa_rebind_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  consumerStepRunId: uuid("consumer_step_run_id").notNull().references(() => workflowStepRuns.id, { onDelete: "cascade" }),
  consumerStepId: text("consumer_step_id").notNull(),
  bundleDigest: text("bundle_digest").notNull(),
  status: text("status").notNull().default("candidate"),
  reasonCode: text("reason_code"),
  expectedDigests: jsonb("expected_digests").$type<Record<string, unknown>>(),
  authorityVersion: integer("authority_version").notNull(),
  executionGeneration: integer("execution_generation").notNull(),
  requestId: text("request_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  authorityId: uuid("authority_id").references(() => workflowRecoveryAuthorities.id),
  classifiedAt: timestamp("classified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  bundleUq: uniqueIndex("workflow_qa_rebind_claims_bundle_uq").on(
    table.companyId, table.workflowRunId, table.consumerStepId, table.bundleDigest),
  pendingIdx: index("workflow_qa_rebind_claims_company_status_idx").on(table.companyId, table.status),
  statusCheck: check("workflow_qa_rebind_claims_status_check", sql`${table.status} in
    ('candidate','auto_eligible','card_required','blocked','excluded','claimed','recovered','dismissed')`),
}));
