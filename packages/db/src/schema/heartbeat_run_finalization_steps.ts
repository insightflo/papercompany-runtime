import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { heartbeatRunFinalizations } from "./heartbeat_run_finalizations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunFinalizationSteps = pgTable(
  "heartbeat_run_finalization_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    heartbeatRunFinalizationId: uuid("heartbeat_run_finalization_id")
      .notNull()
      .references(() => heartbeatRunFinalizations.id),
    stageClass: text("stage_class").notNull(),
    stageKind: text("stage_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull().default("pending"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(0),
    lastError: text("last_error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunIdIdx: index("heartbeat_run_finalization_steps_heartbeat_run_id_idx").on(table.heartbeatRunId),
    finalizationIdIdx: index("heartbeat_run_finalization_steps_finalization_id_idx").on(
      table.heartbeatRunFinalizationId,
    ),
    claimIdx: index("heartbeat_run_finalization_steps_claim_idx")
      .on(table.companyId, table.state, table.leaseExpiresAt)
      .where(sql`${table.state} in ('pending', 'leased')`),
    stageIdempotencyUq: uniqueIndex("heartbeat_run_finalization_steps_stage_idempotency_uq").on(
      table.companyId,
      table.heartbeatRunId,
      table.stageKind,
      table.idempotencyKey,
    ),
  }),
);
