import { sql } from "drizzle-orm";
import { check, pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";
import { issues } from "./issues.js";

/** Controller construction only: originals hashed before insertion; never an HTTP job importer. */
export const workflowCuJobs = pgTable("workflow_cu_jobs", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
  stepRunId: uuid("step_run_id").notNull().references(() => workflowStepRuns.id),
  stepId: text("step_id").notNull(),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  executionGeneration: integer("execution_generation").notNull(),
  specSha256: text("spec_sha256").notNull(),
  job: jsonb("job").$type<Record<string, unknown>>().notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  creatorId: text("creator_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  scopeUq: uniqueIndex("workflow_cu_jobs_scope_uq").on(t.companyId, t.stepRunId, t.executionGeneration, t.id),
  generationCheck: check("workflow_cu_jobs_generation_check", sql`${t.executionGeneration} >= 0`),
  hashCheck: check("workflow_cu_jobs_hash_check", sql`${t.specSha256} ~ '^[0-9a-f]{64}$'`),
}));
