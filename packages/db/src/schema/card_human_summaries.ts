import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * [휴먼카드 초보자 해석본 — 표시 전용 사이드 테이블]
 * 카드 원본(approvals 등)과 그 생성·승인·복구 파이프라인은 무변경이 계약이다.
 * 이 테이블은 (companyId, cardKind, cardId)마다 최신 해석 1행만 가지며,
 * 조회 계층에서 조인해 화면 표시에만 쓴다. 해석 실패는 원문 폴백(표시 문제)일 뿐
 * 카드 처리에 어떤 영향도 주지 않는다.
 */
export const cardHumanSummaries = pgTable(
  "card_human_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** 카드 종류: "approval" | "owner_recovery" | ... (확장 단계에서 추가) */
    cardKind: text("card_kind").notNull(),
    /** 카드 원본 id (approval uuid 등) */
    cardId: text("card_id").notNull(),
    /** pending | done | failed */
    status: text("status").notNull().default("pending"),
    /** 해석에 쓴 어댑터(현재 "pi_local" 일회 CLI 호출) */
    adapterType: text("adapter_type").notNull().default("pi_local"),
    /** 해석에 쓴 모델(빈 값 = CLI 기본 모델) */
    model: text("model").notNull().default(""),
    /** { oneLine, whatHappening, decisionNeeded, options, cautions } — 기계 생성·스키마 검증 계약 */
    summaryJson: jsonb("summary_json").$type<Record<string, unknown> | null>(),
    /** 실패 사유(표시 진단용). 카드 플로우 영향 없음 */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCardIdx: uniqueIndex("card_human_summaries_kind_card_idx").on(
      table.companyId,
      table.cardKind,
      table.cardId,
    ),
  }),
);
