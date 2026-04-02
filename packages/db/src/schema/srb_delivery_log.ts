import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { srbLinks } from "./srb_links.js";

export const srbDeliveryLog = pgTable(
  "srb_delivery_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id").notNull().references(() => srbLinks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown> | null>(),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    linkIdIdx: index("idx_srb_delivery_log_link_id").on(table.linkId),
    statusNextRetryAtIdx: index("idx_srb_delivery_log_status_next_retry_at").on(
      table.status,
      table.nextRetryAt,
    ),
  }),
);
