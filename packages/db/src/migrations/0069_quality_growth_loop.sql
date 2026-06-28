CREATE TABLE IF NOT EXISTS "evaluator_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "evaluator_type" text DEFAULT 'quality_gate' NOT NULL,
  "status" text DEFAULT 'candidate' NOT NULL,
  "source_anchor_case_id" uuid REFERENCES "evaluator_anchor_cases"("id") ON DELETE set null,
  "prompt_patch" text,
  "coverage_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "promoted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_versions_company_status_idx"
  ON "evaluator_versions" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_versions_company_type_idx"
  ON "evaluator_versions" ("company_id", "evaluator_type", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_versions_source_anchor_idx"
  ON "evaluator_versions" ("source_anchor_case_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "evaluator_candidate_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "evaluator_version_id" uuid NOT NULL REFERENCES "evaluator_versions"("id") ON DELETE cascade,
  "anchor_case_id" uuid REFERENCES "evaluator_anchor_cases"("id") ON DELETE set null,
  "review_item_id" uuid REFERENCES "quality_review_items"("id") ON DELETE set null,
  "status" text DEFAULT 'queued' NOT NULL,
  "replay_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "replay_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "coverage_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_candidate_runs_company_status_idx"
  ON "evaluator_candidate_runs" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_candidate_runs_evaluator_idx"
  ON "evaluator_candidate_runs" ("evaluator_version_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_candidate_runs_anchor_idx"
  ON "evaluator_candidate_runs" ("anchor_case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_candidate_runs_review_item_idx"
  ON "evaluator_candidate_runs" ("review_item_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_daily_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "report_date" text NOT NULL,
  "status" text DEFAULT 'generated' NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_evaluator_run_id" uuid REFERENCES "evaluator_candidate_runs"("id") ON DELETE set null,
  "improvement_issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_daily_reports_company_date_idx"
  ON "quality_daily_reports" ("company_id", "report_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_daily_reports_company_status_idx"
  ON "quality_daily_reports" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_daily_reports_evaluator_run_idx"
  ON "quality_daily_reports" ("source_evaluator_run_id");
