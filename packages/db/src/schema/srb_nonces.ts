import {
  pgTable,
  text,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { srbLinks } from "./srb_links.js";

export const srbNonces = pgTable(
  "srb_nonces",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    linkId: uuid("link_id").notNull().references(() => srbLinks.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    linkIdIdx: index("idx_srb_nonces_link_id").on(table.linkId),
    receivedAtIdx: index("idx_srb_nonces_received_at").on(table.receivedAt),
  }),
);
