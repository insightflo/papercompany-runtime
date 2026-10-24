import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { qualityActions } from "./quality_actions.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import type { HumanReviewPacket } from "@paperclipai/shared";

export interface OperatorDecisionDefinitionJson {
  options: Array<{
    id: string;
    label: string;
    description: string | null;
    facts: Array<{ label: string; value: string; status: "known" | "unknown" }>;
    evidenceRefs: Array<{ label: string; href: string }>;
  }>;
  actions: Array<{
    id: string;
    label: string;
    outcome: "submit" | "approve" | "reject" | "hold";
    tone: "primary" | "neutral" | "danger";
    requiresSelection: boolean;
  }>;
  selection: { min: number; max: number } | null;
  comment: {
    mode: "disabled" | "optional" | "required";
    label: string | null;
    placeholder: string | null;
    maxLength: number;
  };
  approvedScope: string[];
  forbiddenScope: string[];
  humanReview?: HumanReviewPacket | null;
}

export interface OperatorDecisionResultJson {
  actionId: string;
  outcome: "submit" | "approve" | "reject" | "hold";
  selectedOptionIds: string[];
  comment: string | null;
}

export interface OperatorDecisionSourceContextJson {
  missionId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  artifactRefs: Array<{ label: string; uri: string }>;
  /** [중복 병합 2026-10-18] mission_owner_human_input pending 카드 병합 전용 메타데이터. create 시점
 *  zod 스키마(strict)에는 없어 신규 생성 카드는 이 키를 갖지 않고, 병합 경로의 갱신으로만
 *  쓰인다(발화·원장 억제 없이 카드 계층에서만 repeatCount 를 센다). */
  /** [승인=시작 묶음 2026-10-22] moi 카드 생성 시점의 활성 계획 결정 해시 — 서버가 create 에서만 기록하며
 *  요청자는 제공·위조할 수 없다. 수정 런 시작 권한은 이 해시가 현재 대기 해시와 일치하는 승인만 인정한다. */
  planDecisionHash?: string | null;
  missionOwnerHumanInput?: {
    repeatCount: number;
    lastSeenDecisionEventId?: string;
  } | null;
}

export const operatorDecisions = pgTable(
  "operator_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    qualityActionId: uuid("quality_action_id"),
    qualityBinding: jsonb("quality_binding").$type<Record<string, unknown>>(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: text("status").notNull().default("pending"),
    priority: text("priority").notNull().default("medium"),
    interactionType: text("interaction_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceContext: jsonb("source_context").$type<OperatorDecisionSourceContextJson>().notNull().default(sql`'{}'::jsonb`),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    definition: jsonb("definition").$type<OperatorDecisionDefinitionJson>().notNull(),
    result: jsonb("result").$type<OperatorDecisionResultJson>(),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    continuationMode: text("continuation_mode").notNull().default("none"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    qualityActionFk: foreignKey({ columns: [table.companyId, table.qualityActionId], foreignColumns: [qualityActions.companyId, qualityActions.id] }),
    qualityContinuationCheck: check("operator_decisions_quality_continuation_check", sql`${table.qualityActionId} is null or ${table.continuationMode} = 'none'`),
    companyRequestUq: uniqueIndex("operator_decisions_company_request_uq").on(table.companyId, table.requestKey),
    companyStatusPriorityCreatedIdx: index("operator_decisions_company_status_priority_created_idx")
      .on(table.companyId, table.status, table.priority, table.createdAt),
    issueCreatedIdx: index("operator_decisions_issue_created_idx")
      .on(table.issueId, table.createdAt)
      .where(sql`${table.issueId} is not null`),
    schemaVersionCheck: check("operator_decisions_schema_version_check", sql`${table.schemaVersion} = 1`),
    statusCheck: check("operator_decisions_status_check", sql`${table.status} in ('pending', 'resolved', 'cancelled')`),
    priorityCheck: check("operator_decisions_priority_check", sql`${table.priority} in ('critical', 'high', 'medium', 'low')`),
    interactionCheck: check("operator_decisions_interaction_check", sql`${table.interactionType} in ('single_select', 'multi_select', 'action')`),
    continuationModeCheck: check("operator_decisions_continuation_mode_check", sql`${table.continuationMode} in ('none', 'issue_current_assignee')`),
    resolvedStateCheck: check(
      "operator_decisions_resolved_state_check",
      sql`${table.status} <> 'resolved' or (${table.result} is not null and ${table.resolvedByUserId} is not null and ${table.resolvedAt} is not null)`,
    ),
    cancelledStateCheck: check(
      "operator_decisions_cancelled_state_check",
      sql`${table.status} <> 'cancelled' or ${table.cancelledAt} is not null`,
    ),
  }),
);
