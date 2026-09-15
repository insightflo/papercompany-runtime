import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NativeBinding, QualityEffect, QualityTarget, RetryEnvelope } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { qualityActionGroups } from "./quality_action_groups.js";
import { qualityPolicyVersions } from "./quality_policy_versions.js";

/**
 * 허가된 Quality 조치. 한 행은 고정된 한 효과/의도를 가진다(UNIQUE (companyId,intentKey)).
 * 새 후보·평가는 새 자식 조치로 연결되고 같은 group 한도를 사용한다.
 * currentDecisionId/currentEvaluationId는 원자적 서버 트랜잭션에서만 쓴다(operator_decisions와의
 * 환형 import를 피하기 위해 FK 없이 회사 조건 조인으로 검증한다).
 */
export const qualityActions = pgTable(
  "quality_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
    parentActionId: uuid("parent_action_id"),
    kind: text("kind").notNull(),
    occurrenceSetHash: text("occurrence_set_hash").notNull(),
    occurrenceIds: jsonb("occurrence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    policyVersionId: uuid("policy_version_id").notNull(),
    scopeVersion: integer("scope_version").notNull(),
    target: jsonb("target").$type<QualityTarget>().notNull(),
    targetHash: text("target_hash").notNull(),
    effect: jsonb("effect").$type<QualityEffect>().notNull(),
    effectHash: text("effect_hash").notNull(),
    retryEnvelope: jsonb("retry_envelope").$type<RetryEnvelope>().notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").notNull(),
    currentDecisionId: uuid("current_decision_id"),
    currentEvaluationId: uuid("current_evaluation_id"),
    intentKey: text("intent_key").notNull(),
    canonicalBinding: jsonb("canonical_binding").$type<NativeBinding>(),
    firstAcceptedRunId: uuid("first_accepted_run_id"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: uniqueIndex("quality_actions_company_id_uq").on(table.companyId, table.id),
    firstAcceptedRunFk: foreignKey({ columns: [table.companyId, table.firstAcceptedRunId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id] }),
    companyIntentUq: uniqueIndex("quality_actions_company_intent_uq").on(table.companyId, table.intentKey),
    groupFk: foreignKey({
      columns: [table.companyId, table.groupId],
      foreignColumns: [qualityActionGroups.companyId, qualityActionGroups.id],
    }).onDelete("cascade"),
    policyFk: foreignKey({
      columns: [table.companyId, table.policyVersionId],
      foreignColumns: [qualityPolicyVersions.companyId, qualityPolicyVersions.id],
    }),
    parentFk: foreignKey({
      columns: [table.companyId, table.parentActionId],
      foreignColumns: [table.companyId, table.id],
    }),
    kindCheck: check("quality_actions_kind_check", sql`${table.kind} in ('current_output', 'qa_addendum')`),
    revisionPositiveCheck: check("quality_actions_revision_positive_check", sql`${table.revision} >= 1`),
    companyGroupIdx: index("quality_actions_company_group_idx").on(table.companyId, table.groupId),
    companyStateIdx: index("quality_actions_company_state_idx").on(table.companyId, table.state, table.createdAt),
  }),
);
