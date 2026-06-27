import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { missions } from "./missions.js";

export const missionPlanDecisionSubmissions = pgTable(
  "mission_plan_decision_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    planningIssueId: uuid("planning_issue_id").references(() => issues.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    decisionHash: text("decision_hash").notNull(),
    decision: jsonb("decision").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("accepted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionHashIdx: uniqueIndex("mission_plan_decision_submissions_mission_hash_idx")
      .on(table.companyId, table.missionId, table.decisionHash),
    missionCreatedIdx: index("mission_plan_decision_submissions_mission_created_idx")
      .on(table.companyId, table.missionId, table.createdAt),
  }),
);
