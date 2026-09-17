import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  JudgmentAnswer,
  JudgmentAskState,
  JudgmentDefinitionSnapshot,
  JudgmentQuestion,
} from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * 판단 계층(judgment layer) 테이블 — 트랙 B-1.
 *
 * 원칙: "모델은 추천하고, 정책은 허용하며, 검증기는 완료를 확인한다."
 * 판단 결과는 실행 권한이 아니라 권고다. 실행제어 경로(하트비트/워크플로우/PLAN-QA)는
 * 이 테이블을 읽지 않으며, 연동은 B-2 이후다.
 *
 * - judgment_definitions: 회사별 판단 정의(질문 묶음+정책 임계값). 버전 관리되며
 *   활성(isActive) 버전이 호출에 사용된다. modelId 는 고정 버전 ID(별칭 금지).
 * - judgment_calls: 판단 호출 감사행. 성공/실패/비활성 무관 1행씩 기록되며
 *   "왜 시스템이 그 답을 실행에 사용했는가"를 재구성할 수 있어야 한다
 *   (실제 보낸 state/questions, 받은 answers, 확률/신뢰도, 모델 버전, 정의 버전 스냅샷,
 *   시도 횟수, 지연시간, 토큰 사용량, 비용, 결과, 에러).
 * - outcome 은 'executed' | 'observed' | 'error' | 'disabled' (text + shared zod 검증).
 *   현재 생성 경로는 'observed' 뿐이다.
 * - definitionId 는 NOT NULL + restrict: 감사행은 정의 삭제로 사라지지 않는다.
 *   활성 정의가 없는 호출은 행을 만들 수 없고(정의를 참조할 수 없으므로) 서비스가
 *   auditId 없는 error 결과로 반환한다.
 * - correlationKey 는 contextType+contextId 조합(예: "mission_plan_qa:<id>")으로
 *   같은 맥락의 판단들을 묶어 조회하는 용도다.
 */

export const judgmentDefinitions = pgTable(
  "judgment_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    definition: jsonb("definition").$type<JudgmentDefinitionSnapshot>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameVersionUq: uniqueIndex("judgment_definitions_company_name_version_uq").on(
      table.companyId,
      table.name,
      table.version,
    ),
  }),
);

export const judgmentCalls = pgTable(
  "judgment_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => judgmentDefinitions.id, { onDelete: "restrict" }),
    definitionVersion: integer("definition_version").notNull(),
    contextType: text("context_type").notNull(),
    contextId: text("context_id").notNull(),
    correlationKey: text("correlation_key"),
    inputState: jsonb("input_state").$type<JudgmentAskState>().notNull(),
    questions: jsonb("questions").$type<JudgmentQuestion[]>().notNull(),
    answers: jsonb("answers").$type<JudgmentAnswer[]>(),
    outcome: text("outcome").notNull(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    providerId: text("provider_id"),
    modelVersion: text("model_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyContextCreatedAtIdx: index("idx_judgment_calls_company_context_created_at").on(
      table.companyId,
      table.contextType,
      table.contextId,
      table.createdAt,
    ),
    correlationKeyIdx: index("idx_judgment_calls_correlation_key").on(table.correlationKey),
  }),
);
