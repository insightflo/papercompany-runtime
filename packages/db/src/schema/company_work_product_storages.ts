import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyWorkProductStorages = pgTable(
  "company_work_product_storages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("local_disk"),
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    keyPrefix: text("key_prefix"),
    forcePathStyle: boolean("force_path_style").notNull().default(false),
    accessKeySecretId: uuid("access_key_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    secretAccessKeySecretId: uuid("secret_access_key_secret_id")
      .references(() => companySecrets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_work_product_storages_company_uq").on(table.companyId),
    companyProviderIdx: index("company_work_product_storages_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
  }),
);
