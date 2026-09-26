// packages/db/src/schema/effect_intents.ts
//
// [effect envelope] 비용·불가역 외부 효과의 이중 실행 방지 내구 장부.
//   효과 실행 전 status='intent' 기록, 실행 후 CAS 로 'applied' 표기.
//   effect_id 는 자연키 해시(company + effect_kind + anchor + generation + params_hash)로
//   동일 논리 효과의 replay 는 skipped 된다. 깨움 outbox(agent_wakeup_requests)와 독립적
//   감사 대상이므로 그 스키마는 건드리지 않는다.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const effectIntents = pgTable(
  "effect_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    effectKind: text("effect_kind").notNull(),
    effectId: text("effect_id").notNull(),
    anchorKey: text("anchor_key").notNull(),
    generationKey: text("generation_key").notNull(),
    paramsHash: text("params_hash").notNull(),
    status: text("status").notNull().default("intent"),
    attemptRunId: text("attempt_run_id"),
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("effect_intents_effect_id_key").on(t.effectId),
    index("effect_intents_company_kind_anchor_idx").on(t.companyId, t.effectKind, t.anchorKey),
    index("effect_intents_status_idx").on(t.status),
  ],
);

export type EffectIntent = typeof effectIntents.$inferSelect;
export type NewEffectIntent = typeof effectIntents.$inferInsert;
