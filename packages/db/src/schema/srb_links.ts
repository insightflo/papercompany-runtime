import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const srbLinks = pgTable(
  "srb_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localCompanyId: uuid("local_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    remoteCompanyId: text("remote_company_id").notNull(),
    remoteServerUrl: text("remote_server_url"),
    direction: text("direction").notNull(),
    sharedSecretId: uuid("shared_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    localCompanyIdIdx: index("idx_srb_links_local_company_id").on(table.localCompanyId),
  }),
);
