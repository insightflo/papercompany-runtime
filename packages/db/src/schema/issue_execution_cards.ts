import {
  index,
  integer,
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
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";

export type IssueExecutionCardJson = {
  version: 1;
  issue: {
    id?: string;
    title: string;
    assigneeAgentId?: string | null;
    projectId?: string | null;
    originKind?: string | null;
  };
  workflow?: {
    definitionId?: string | null;
    runId?: string | null;
    stepRunId?: string | null;
    stepId?: string | null;
    qaType?: string | null;
    qaInputScope?: string | null;
    dependencyStepIds: string[];
  };
  requiredOutputs: {
    workProduct: {
      required: boolean;
      outputDir?: string | null;
      artifactMarker: "[ARTIFACT]: <absolute path>";
    };
    verdict: {
      required: boolean;
      ledger: "workflow_validation_verdict" | "mission_plan_qa_verdict" | null;
      allowed: readonly ["PASS", "REQUEST_CHANGES"] | [];
    };
    deliveryReadback: {
      required: boolean;
      marker?: string | null;
    };
  };
  toolPermissionContract?: {
    requiredToolNames: string[];
    requiredKnowledgeNames: string[];
    allowedSearchScopes?: string[];
  };
  evidenceRefs: Array<{
    type: string;
    id?: string;
    path?: string;
    description?: string;
  }>;
  preservedProseMarkers: string[];
  source: {
    descriptionHash: string;
    generatedBy: string;
  };
};

export const issueExecutionCards = pgTable(
  "issue_execution_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
    workflowStepRunId: uuid("workflow_step_run_id").references(() => workflowStepRuns.id, { onDelete: "set null" }),
    cardVersion: integer("card_version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    cardJson: jsonb("card_json").$type<IssueExecutionCardJson>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueUnique: uniqueIndex("issue_execution_cards_company_issue_uq").on(table.companyId, table.issueId),
    missionUpdatedIdx: index("idx_issue_execution_cards_mission_updated").on(table.companyId, table.missionId, table.updatedAt),
    workflowRunIdx: index("idx_issue_execution_cards_workflow_run").on(table.workflowRunId),
    contentHashIdx: index("idx_issue_execution_cards_content_hash").on(table.contentHash),
  }),
);
