import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { workflowRuns } from "./workflow_runs.js";

/**
 * [목적] Task6a bounded resume 요청의 durable 저장소.
 *   같은 (company, run, idempotencyKey) 재시도는 새 reset 이 아니라 기존 요청 row 로 replay 된다.
 *   requestBody 해시는 snapshotToken/reason 을 포함한 정규화 전체 body 기준이다.
 *   감사 레코드이므로 FK 는 cascade 없이 no action (부모 정리 경로와 무관하게 이력 보존).
 */
export const workflowResumeRequests = pgTable(
  "workflow_resume_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    definitionHash: text("definition_hash").notNull(),
    requestBody: jsonb("request_body").$type<Record<string, unknown>>().notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
    appliedGenerations: jsonb("applied_generations").$type<Record<string, number>>().notNull(),
    state: text("state").notNull().default("pending_delivery"),
    code: text("code"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdempotencyUq: uniqueIndex("workflow_resume_requests_run_idempotency_uq").on(
      table.companyId,
      table.workflowRunId,
      table.idempotencyKey,
    ),
    stateLeaseIdx: index("idx_workflow_resume_requests_state_lease_until").on(
      table.state,
      table.leaseUntil,
    ),
    stateCheck: check(
      "workflow_resume_requests_state_check",
      sql`${table.state} in ('pending_delivery', 'accepted', 'blocked', 'cancelled')`,
    ),
    deliveryAttemptsCheck: check(
      "workflow_resume_requests_delivery_attempts_check",
      sql`${table.deliveryAttempts} >= 0`,
    ),
    leaseCheck: check(
      "workflow_resume_requests_lease_check",
      sql`(${table.leaseOwner} is null and ${table.leaseUntil} is null) or (${table.leaseOwner} is not null and ${table.leaseUntil} is not null)`,
    ),
  }),
);
