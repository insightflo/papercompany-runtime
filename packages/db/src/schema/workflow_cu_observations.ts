import { sql } from "drizzle-orm";
import { check, pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowCuJobs } from "./workflow_cu_jobs.js";

/** Immutable attributed observations, not machine proof of screenshot semantics. */
export const workflowCuObservations = pgTable("workflow_cu_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordId: text("record_id").notNull(),
  jobId: uuid("job_id").notNull().references(() => workflowCuJobs.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(),
  observerId: text("observer_id").notNull(),
  observationKind: text("observation_kind").notNull(),
  revision: integer("revision").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  screenshotBase64: text("screenshot_base64").notNull(),
  screenshotSha256: text("screenshot_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  recordUq: uniqueIndex("workflow_cu_observations_record_uq").on(t.companyId, t.jobId, t.recordId),
  revisionUq: uniqueIndex("workflow_cu_observations_revision_uq").on(t.jobId, t.revision),
  revisionCheck: check("workflow_cu_observations_revision_check", sql`${t.revision} > 0`),
  kindCheck: check("workflow_cu_observations_kind_check", sql`${t.kind} in ('provenance', 'credit', 'budget')`),
  observationCheck: check("workflow_cu_observations_observation_check", sql`${t.observationKind} = 'computer_use_observation'`),
  hashCheck: check("workflow_cu_observations_hash_check", sql`${t.screenshotSha256} ~ '^[0-9a-f]{64}$'`),
}));
