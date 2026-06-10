CREATE TABLE IF NOT EXISTS "workflow_delegations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "source_workflow_step_run_id" uuid NOT NULL REFERENCES "workflow_step_runs"("id") ON DELETE CASCADE,
  "source_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "target_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "target_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  "metadata" jsonb,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_delegations_source_step_run_uq"
  ON "workflow_delegations" ("source_workflow_step_run_id");
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_delegations_target_issue_uq"
  ON "workflow_delegations" ("target_issue_id");
CREATE INDEX IF NOT EXISTS "workflow_delegations_source_company_status_idx"
  ON "workflow_delegations" ("source_company_id", "status");
CREATE INDEX IF NOT EXISTS "workflow_delegations_target_company_issue_idx"
  ON "workflow_delegations" ("target_company_id", "target_issue_id");
