import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { missions } from "./missions.js";

export type MissionDelegationMetadata = Record<string, unknown>;

export const missionDelegations = pgTable(
  "mission_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceMissionId: uuid("source_mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    externalKey: text("external_key"),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetMissionId: uuid("target_mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<MissionDelegationMetadata>().notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceMissionIdx: index("idx_mission_delegations_source_mission").on(table.sourceCompanyId, table.sourceMissionId),
    externalKeyUniqueIdx: uniqueIndex("mission_delegations_source_external_key_uq").on(table.sourceMissionId, table.externalKey),
    targetMissionIdx: index("idx_mission_delegations_target_mission").on(table.targetCompanyId, table.targetMissionId),
    statusIdx: index("idx_mission_delegations_status").on(table.status),
    targetMissionUniqueIdx: uniqueIndex("mission_delegations_target_mission_uq").on(table.targetMissionId),
  }),
);
