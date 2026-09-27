import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `plugin_tool_execution_receipts` table — inbound idempotency receipts for
 * `POST /api/plugins/tools/execute`.
 *
 * When a caller supplies an `idempotencyKey`, exactly one row exists per
 * (company, run, tool, key): the unique index makes the claim insert atomic,
 * so exactly one concurrent request executes the tool. A later retry of a
 * `completed` receipt replays the stored response (`x-idempotent-replay`)
 * instead of re-running side effects. An `executing` receipt answers 409 while
 * fresh and can be taken over after the stale window (crash recovery).
 *
 * `run_id` is the raw runContext.runId string (no FK — board callers may pass
 * arbitrary strings because board tool calls do not validate heartbeat runs).
 *
 * @see PLUGIN_SPEC.md §13.10 — tool execution idempotency
 * @see server/src/services/plugin-tool-execution-receipt.ts — claim semantics
 */
export const pluginToolExecutionReceipts = pgTable(
  "plugin_tool_execution_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning company. Cascades on delete. */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Raw runContext.runId (audit string, not an FK — see table doc). */
    runId: text("run_id").notNull(),
    /** Fully namespaced tool name from the request. */
    tool: text("tool").notNull(),
    /** Caller-supplied stable effect key for one logical tool call. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Claim lifecycle: `executing` while the tool runs, `completed` after. */
    status: text("status").$type<"executing" | "completed">().notNull(),
    /** Original request parameters (audit copy). */
    requestParameters: jsonb("request_parameters").$type<unknown>().notNull().default({}),
    /** Stored terminal HTTP status of the recorded execution (null while executing). */
    resultStatus: integer("result_status"),
    /** Stored final response body, already condensed (null while executing). */
    resultBody: jsonb("result_body").$type<unknown>(),
    /** When this receipt was claimed (refreshed on stale takeover). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the recorded execution finished. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Workflow trace metadata from stepEnv when present (not part of uniqueness). */
    workflowRunId: uuid("workflow_run_id"),
    stepId: text("step_id"),
  },
  (table) => ({
    companyIdx: index("plugin_tool_execution_receipts_company_idx").on(table.companyId),
    // Receipt uniqueness: one row per (company, run, tool, idempotency key).
    identityUq: uniqueIndex("plugin_tool_execution_receipts_identity_uq").on(
      table.companyId,
      table.runId,
      table.tool,
      table.idempotencyKey,
    ),
    statusCheck: check(
      "plugin_tool_execution_receipts_status_check",
      sql`${table.status} in ('executing', 'completed')`,
    ),
  }),
);
