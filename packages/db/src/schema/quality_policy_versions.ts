import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { QualityPolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * 회사별 Quality 정책 버전. definition은 불변이고 새 정책은 새 행이다.
 * 회사당 활성 정책은 부분 UNIQUE로 하나만 허용하며 자동 활성화는 없다.
 */
export const qualityPolicyVersions = pgTable(
  "quality_policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<QualityPolicy>().notNull(),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyVersionUq: uniqueIndex("quality_policy_versions_company_version_uq").on(table.companyId, table.version),
    // 자식 테이블의 (companyId, policyVersionId) 복합 FK 대상.
    companyIdUq: uniqueIndex("quality_policy_versions_company_id_uq").on(table.companyId, table.id),
    companyActiveUq: uniqueIndex("quality_policy_versions_company_active_uq")
      .on(table.companyId)
      .where(sql`${table.enabledAt} is not null and ${table.disabledAt} is null`),
    versionPositiveCheck: check("quality_policy_versions_version_positive_check", sql`${table.version} >= 1`),
    enabledRequiresApprovalCheck: check(
      "quality_policy_versions_enabled_requires_approval_check",
      sql`${table.enabledAt} is null or (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)`,
    ),
    disabledAfterEnabledCheck: check(
      "quality_policy_versions_disabled_after_enabled_check",
      sql`${table.disabledAt} is null or ${table.enabledAt} is not null`,
    ),
    companyEnabledIdx: index("quality_policy_versions_company_enabled_idx").on(table.companyId, table.enabledAt),
  }),
);
