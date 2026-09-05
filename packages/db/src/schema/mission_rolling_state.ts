import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * [결정 지위 — A안 2026-09-05] 미션 결정 로그의 수명주기 지위.
 * 규칙 8: 이 지위는 다음 에이전트에게 맥락을 전달하는 표시용 상태일 뿐, 실행 통제
 * (retry/complete/branch/QA 판정)의 권위가 아니다. 스텝 성패의 진실원은 엔진의
 * run/issue 상태 그대로다. 어떤 실행 통제 코드도 이 필드를 읽어 판단해서는 안 된다.
 */
export type MissionDecisionStatus = "confirmed" | "under_review" | "retired";

/**
 * [결정 근거 참조 — A안 후속 2026-09-05] 결정 로그 항목에 붙는 구조화된 근거 참조.
 * 지식패턴 카드의 evidence({type,id,note}) 선례를 그대로 따른다. 규칙 8: 참조는
 * 다음 에이전트/보드에게 근거를 전달하는 표시용 구조 데이터일 뿐, 실행 통제가
 * 이를 읽어 판단하지 않는다. 자연어 파싱 없이 입력 시점에 구조화된다.
 * - sha256: 참조 대상 아티팩트의 내용 해시(선택, 64 hex 소문자).
 */
export type MissionDecisionEvidenceRef = {
  type: "heartbeat_run" | "issue" | "issue_comment" | "run_log" | "work_product" | "pr" | "mission";
  id: string;
  note?: string;
  sha256?: string;
};

/**
 * [결정 레코드 — A안] 롤링 상태가 유지하는 결정 로그 항목.
 * - supersedes: 이 결정이 대체한 이전 결정 id (대체링크). 대체된 결정은 retired 로
 *   로그에 남는다(폐기된 결정까지 붙들어야 지금이 보인다 — 온톨로지 논문).
 * - handoffId/updatedAt: 이 상태를 쓴 핸드오프 출처(근거 추적용).
 */
export type MissionRollingDecisionRecord = {
  id: string;
  summary: string;
  status: MissionDecisionStatus;
  supersedes?: string | null;
  handoffId?: string | null;
  updatedAt?: string | null;
  evidenceRefs?: MissionDecisionEvidenceRef[];
};

export type MissionRollingStateJson = {
  missionGoal?: string | null;
  currentPlan?: string | null;
  completedIssues?: Array<{ issueId: string; summary: string; handoffId?: string }>;
  activeDecisions?: string[];
  decisions?: MissionRollingDecisionRecord[];
  knownConstraints?: string[];
  openQuestions?: string[];
  blockers?: string[];
  nextRecommendedIssue?: string | null;
  handoffIndex?: Array<{ issueId: string | null; handoffId: string; status: string; createdAt: string }>;
};

export const missionRollingState = pgTable(
  "mission_rolling_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("active"),
    stateMarkdown: text("state_markdown").notNull().default(""),
    stateJson: jsonb("state_json").$type<MissionRollingStateJson>().notNull().default({}),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastCompactedAt: timestamp("last_compacted_at", { withTimezone: true }),
    totalRuns: integer("total_runs").notNull().default(0),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionUniqueIdx: uniqueIndex("mission_rolling_state_mission_id_key").on(table.missionId),
    companyStatusIdx: index("idx_mission_rolling_state_company_status").on(table.companyId, table.status),
    companyUpdatedIdx: index("idx_mission_rolling_state_company_updated").on(table.companyId, table.updatedAt),
  }),
);
