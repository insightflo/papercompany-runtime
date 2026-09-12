import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { qualityPolicyVersions } from "./quality_policy_versions.js";

/**
 * 조치 묶음(group). 조상 묶음 잠금 아래 후보·평가·바깥 반복·증거 재요청·실행 예약/실사용 계수를
 * 누적한다. 새 결정·자식 조치가 사용량을 초기화하지 않는다. 정책 교체로도 초기화하지 않는다.
 */
export const qualityActionGroups = pgTable(
  "quality_action_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    policyVersionId: uuid("policy_version_id").notNull(),
    rootOccurrenceSetHash: text("root_occurrence_set_hash").notNull(),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPolicyFk: foreignKey({
      columns: [table.companyId, table.policyVersionId],
      foreignColumns: [qualityPolicyVersions.companyId, qualityPolicyVersions.id],
    }).onDelete("cascade"),
    companyIdUq: uniqueIndex("quality_action_groups_company_id_uq").on(table.companyId, table.id),
    companyPolicyIdx: index("quality_action_groups_company_policy_idx").on(table.companyId, table.policyVersionId),
    revisionPositiveCheck: check("quality_action_groups_revision_positive_check", sql`${table.revision} >= 1`),
  }),
);
