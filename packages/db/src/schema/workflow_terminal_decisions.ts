import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";

// [run-terminal-boundary v1 — stage-3 계약 PR-1] 실행 종결은 원인 스탬프된 결정 레코드로
// 내구화한다. (company, run, decided authority version) 단위 유니크로 결정은 1회만 기록되며,
// 종결 시점에 캡처한 정지 대상과 커밋 후 부작용 인텐트(outbox)를 함께 남긴다.

/** 종결 시 캡처되는 정지 대상 스냅샷(관측 사실 — 실행 권위는 인텐트 행이 아닌 결정 행의 계약). */
export interface WorkflowTerminalStopTargets {
  runtimeIds: string[];
  heartbeatRunIds: string[];
  supersededUnblockIssueIds: string[];
}

export const workflowTerminalDecisions = pgTable(
  "workflow_terminal_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    decidedAuthorityVersion: integer("decided_authority_version").notNull(),
    decision: text("decision").notNull(),
    policyCause: text("policy_cause").notNull(),
    discoveryPath: text("discovery_path").notNull(),
    origin: text("origin").notNull(),
    reason: text("reason"),
    recoveryGate: jsonb("recovery_gate").$type<Record<string, unknown>>().notNull().default({}),
    capturedStopTargets: jsonb("captured_stop_targets")
      .$type<WorkflowTerminalStopTargets>()
      .notNull()
      .default({ runtimeIds: [], heartbeatRunIds: [], supersededUnblockIssueIds: [] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // 동일 (run, authority version) 결정은 정확히 하나 — 재종결/이력 위조 차단.
    runVersionUq: uniqueIndex("workflow_terminal_decisions_run_version_uq").on(
      table.companyId,
      table.workflowRunId,
      table.decidedAuthorityVersion,
    ),
  }),
);

export const workflowTerminalEffectIntents = pgTable(
  "workflow_terminal_effect_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    terminalDecisionId: uuid("terminal_decision_id")
      .notNull()
      .references(() => workflowTerminalDecisions.id, { onDelete: "cascade" }),
    effectKind: text("effect_kind").notNull(),
    targetId: text("target_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    // 결정 1건당 대상별 인텐트 1개 — 중복 캡처는 무해한 no-op(onConflictDoNothing).
    targetUq: uniqueIndex("workflow_terminal_effect_intents_target_uq").on(
      table.terminalDecisionId,
      table.effectKind,
      table.targetId,
    ),
    companyStatusCreatedIdx: index("workflow_terminal_effect_intents_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
  }),
);
