import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowTerminalDecisions } from "./workflow_terminal_decisions.js";

/**
 * [공식 복구 권한] 종결 경계(workflow_terminal_decisions)가 기록한 결정 1건을
 * 정확히 1회 소비해 실행을 되살린 사실. (run, 대상 권한버전) 유니크로 1회 소비를
 * 강제한다 — 낡은 승인이 새 종결 상태를 되살리는 것을 버전 일치 검증과 함께 차단.
 * requestReference 는 호출자 멱등 키(감독 재시도 키 등)로, 같은 명령 재시도가
 * 이중 소비로 보이지 않게 한다.
 */
export const workflowRecoveryAuthorities = pgTable(
  "workflow_recovery_authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    targetAuthorityVersion: integer("target_authority_version").notNull(),
    targetDecisionId: uuid("target_decision_id").notNull().references(() => workflowTerminalDecisions.id),
    recoveryKind: text("recovery_kind").notNull(),
    requestReference: text("request_reference"),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("consumed"), // [봇 지적 기록] 현재는 'consumed' 단일값 — 향후 revoked 확장 대비 예약.
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
    resultingAuthorityVersion: integer("resulting_authority_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // 1회 소비 — 같은 (run, 대상 버전) 복구 권한은 정확히 하나.
    runVersionUq: uniqueIndex("workflow_recovery_authorities_run_version_uq").on(
      table.companyId,
      table.workflowRunId,
      table.targetAuthorityVersion,
    ),
    // 멱등 키 — 같은 (run, 종류, 키, 대상 버전) 재시도는 같은 권한을 가리킨다.
    //   [봇 지적 교정] 버전 포함: 같은 키(예: 언블록 이슈 id)가 이후 버전의 새 실패를
    //   이전 소비로 오인해 되살림을 건너뛰는 일이 없어야 한다.
    kindReferenceUq: uniqueIndex("workflow_recovery_authorities_kind_reference_uq").on(
      table.companyId,
      table.workflowRunId,
      table.recoveryKind,
      table.requestReference,
      table.targetAuthorityVersion,
    ),
  }),
);
