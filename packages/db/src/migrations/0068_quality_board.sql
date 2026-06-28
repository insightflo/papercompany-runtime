CREATE TABLE IF NOT EXISTS "quality_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "mission_id" uuid REFERENCES "missions"("id") ON DELETE set null,
  "title" text NOT NULL,
  "status" text DEFAULT 'detected' NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "trigger_source" text NOT NULL,
  "trigger_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "failure_type" text,
  "priority" text DEFAULT 'medium' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_review_items_company_status_idx"
  ON "quality_review_items" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_review_items_company_trigger_idx"
  ON "quality_review_items" ("company_id", "trigger_source", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_review_items_company_mission_idx"
  ON "quality_review_items" ("company_id", "mission_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_evidence_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "review_item_id" uuid NOT NULL REFERENCES "quality_review_items"("id") ON DELETE cascade,
  "surface" text NOT NULL,
  "expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actual" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'missing' NOT NULL,
  "collected_by_actor_type" text,
  "collected_by_actor_id" text,
  "source_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE set null,
  "source_url" text,
  "collected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "freshness_expires_at" timestamp with time zone,
  "blocking" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_evidence_refs_review_item_idx"
  ON "quality_evidence_refs" ("review_item_id", "surface");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_evidence_refs_company_status_idx"
  ON "quality_evidence_refs" ("company_id", "status", "surface");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mission_quality_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "review_item_id" uuid NOT NULL REFERENCES "quality_review_items"("id") ON DELETE cascade,
  "mission_id" uuid REFERENCES "missions"("id") ON DELETE set null,
  "target_type" text NOT NULL,
  "target_id" text,
  "verdict" text NOT NULL,
  "failure_type" text,
  "reason" text,
  "decided_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_quality_verdicts_review_item_idx"
  ON "mission_quality_verdicts" ("review_item_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_quality_verdicts_company_verdict_idx"
  ON "mission_quality_verdicts" ("company_id", "verdict", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_quality_verdicts_company_mission_idx"
  ON "mission_quality_verdicts" ("company_id", "mission_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "evaluator_anchor_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_verdict_id" uuid NOT NULL REFERENCES "mission_quality_verdicts"("id") ON DELETE cascade,
  "review_item_id" uuid NOT NULL REFERENCES "quality_review_items"("id") ON DELETE cascade,
  "mission_id" uuid REFERENCES "missions"("id") ON DELETE set null,
  "title" text NOT NULL,
  "failure_type" text,
  "verdict" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'candidate' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_anchor_cases_company_status_idx"
  ON "evaluator_anchor_cases" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_anchor_cases_review_item_idx"
  ON "evaluator_anchor_cases" ("review_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluator_anchor_cases_source_verdict_idx"
  ON "evaluator_anchor_cases" ("source_verdict_id");
