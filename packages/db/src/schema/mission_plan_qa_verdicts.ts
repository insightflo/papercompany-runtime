import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { missionPlanArtifacts } from "./mission_plan_artifacts.js";
import { missions } from "./missions.js";

export const missionPlanQaVerdicts = pgTable(
  "mission_plan_qa_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    missionPlanArtifactId: uuid("mission_plan_artifact_id").references(() => missionPlanArtifacts.id, { onDelete: "set null" }),
    planQaIssueId: uuid("plan_qa_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reviewerUserId: text("reviewer_user_id"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    decisionHash: text("decision_hash").notNull(),
    verdict: text("verdict").notNull(),
    diagnostics: jsonb("diagnostics").$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueHashIdx: uniqueIndex("mission_plan_qa_verdicts_issue_hash_idx")
      .on(table.companyId, table.planQaIssueId, table.decisionHash),
    missionCreatedIdx: index("mission_plan_qa_verdicts_mission_created_idx")
      .on(table.companyId, table.missionId, table.createdAt),
  }),
);
