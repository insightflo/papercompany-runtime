import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { SourceAttempt } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { qualityReviewItems } from "./quality_review_items.js";

/**
 * 검증된 품질 발생(occurrence). 같은 (회사, 생산 실행, 제출 키)는 한 행이다.
 * 같은 키·다른 본문 해시는 서비스 계층에서 409로 거부하고 다음 생산 시도는 새 발생이 된다.
 */
export const qualityOccurrences = pgTable(
  "quality_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reviewItemId: uuid("review_item_id").notNull(),
    producerRunId: uuid("producer_run_id").notNull(),
    submissionKey: text("submission_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceBinding: jsonb("source_binding").$type<SourceAttempt>().notNull(),
    evidenceRefIds: jsonb("evidence_ref_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewItemFk: foreignKey({ columns: [table.companyId, table.reviewItemId], foreignColumns: [qualityReviewItems.companyId, qualityReviewItems.id] }).onDelete("cascade"),
    producerFk: foreignKey({ columns: [table.companyId, table.producerRunId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id] }),
    companyProducerKeyUq: uniqueIndex("quality_occurrences_company_producer_key_uq")
      .on(table.companyId, table.producerRunId, table.submissionKey),
    companyReceivedIdx: index("quality_occurrences_company_received_idx").on(table.companyId, table.receivedAt),
    reviewItemIdx: index("quality_occurrences_review_item_idx").on(table.reviewItemId),
    payloadHashCheck: check(
      "quality_occurrences_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
