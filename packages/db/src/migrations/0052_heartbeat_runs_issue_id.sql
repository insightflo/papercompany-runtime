ALTER TABLE "heartbeat_runs"
ADD COLUMN "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL;

CREATE INDEX "heartbeat_runs_company_issue_created_idx"
ON "heartbeat_runs" ("company_id", "issue_id", "created_at");
