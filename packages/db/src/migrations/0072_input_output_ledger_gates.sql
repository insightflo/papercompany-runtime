ALTER TABLE "mission_plan_decision_submissions"
  ADD COLUMN IF NOT EXISTS "rejection_reason" text;
--> statement-breakpoint
ALTER TABLE "mission_plan_decision_submissions"
  ADD COLUMN IF NOT EXISTS "diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL;
