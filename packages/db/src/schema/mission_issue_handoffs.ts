import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missions } from "./missions.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { missionSessions } from "./mission_sessions.js";

export type MissionIssueHandoffEvidenceRef = {
  type: string;
  id?: string;
  path?: string;
  url?: string;
  description?: string;
};

export type MissionIssueHandoffJson = {
  issueGoal?: string;
  inputContextUsed?: string[];
  actionsTaken?: string[];
  decisionsMade?: string[];
  outputArtifact?: string | null;
  evidence?: MissionIssueHandoffEvidenceRef[];
  importantCaveats?: string[];
  remainingWorkThisIssue?: string[];
  remainingWorkMission?: string[];
  stateDelta?: Record<string, unknown>;
  recommendedNextPrompt?: string | null;
};

export const missionIssueHandoffs = pgTable(
  "mission_issue_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    missionSessionId: uuid("mission_session_id").references(() => missionSessions.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    handoffVersion: integer("handoff_version").notNull().default(1),
    handoffMarkdown: text("handoff_markdown").notNull(),
    handoffJson: jsonb("handoff_json").$type<MissionIssueHandoffJson>().notNull().default({}),
    evidenceRefsJson: jsonb("evidence_refs_json").$type<MissionIssueHandoffEvidenceRef[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionCreatedIdx: index("idx_mission_issue_handoffs_mission_created").on(table.companyId, table.missionId, table.createdAt),
    issueCreatedIdx: index("idx_mission_issue_handoffs_issue_created").on(table.issueId, table.createdAt),
    agentMissionIdx: index("idx_mission_issue_handoffs_agent_mission").on(table.companyId, table.agentId, table.missionId),
    runUniqueIdx: uniqueIndex("mission_issue_handoffs_run_id_key").on(table.runId),
  }),
);
