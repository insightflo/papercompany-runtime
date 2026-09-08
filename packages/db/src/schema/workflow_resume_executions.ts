import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { workflowResumeRequests } from "./workflow_resume_requests.js";
import { workflowRuns } from "./workflow_runs.js";

/**
 * [목적] Task6a resume 실행 자체의 영구 레코드.
 *   이 row 가 실행 항목이며 accepted 표시로 대체하지 않는다. 요청 1건당 실행 1건(unique request_id).
 *   감사 레코드이므로 FK 는 cascade 없이 no action.
 */
export const workflowResumeExecutions = pgTable(
  "workflow_resume_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => workflowResumeRequests.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
    authorityVersion: integer("authority_version").notNull(),
    generations: jsonb("generations").$type<Record<string, number>>().notNull(),
    state: text("state").notNull().default("queued"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    code: text("code"),
  },
  (table) => ({
    requestUq: uniqueIndex("workflow_resume_executions_request_uq").on(table.requestId),
    stateLeaseIdx: index("idx_workflow_resume_executions_state_lease_until").on(
      table.state,
      table.leaseUntil,
    ),
    stateCheck: check(
      "workflow_resume_executions_state_check",
      sql`${table.state} in ('queued', 'running', 'completed', 'blocked', 'cancelled')`,
    ),
    authorityVersionCheck: check(
      "workflow_resume_executions_authority_version_check",
      sql`${table.authorityVersion} >= 0`,
    ),
    attemptsCheck: check(
      "workflow_resume_executions_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    leaseCheck: check(
      "workflow_resume_executions_lease_check",
      sql`(${table.leaseOwner} is null and ${table.leaseUntil} is null) or (${table.leaseOwner} is not null and ${table.leaseUntil} is not null)`,
    ),
  }),
);
