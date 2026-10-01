import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

/** Server-written board approval. Caller run/step metadata is never seed authority. */
export const workflowRunSeeds = pgTable("workflow_run_seeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  targetRunId: uuid("target_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  targetStepRunId: uuid("target_step_run_id").notNull(),
  targetStepId: text("target_step_id").notNull(),
  sourceRunId: uuid("source_run_id").notNull().references(() => workflowRuns.id),
  sourceStepRunId: uuid("source_step_run_id").notNull().references(() => workflowStepRuns.id),
  sourceStepId: text("source_step_id").notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  approvedByUserId: text("approved_by_user_id").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ targetStep: uniqueIndex("workflow_run_seeds_target_step_idx").on(table.targetRunId, table.targetStepId) }));
