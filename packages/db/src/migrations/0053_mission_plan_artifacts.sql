CREATE TABLE "mission_plan_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE CASCADE,
  "revision" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "owner_agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "mission_goal" text NOT NULL,
  "refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "required_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "success_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_plan_artifacts_mission_revision_uq"
ON "mission_plan_artifacts" ("mission_id", "revision");
--> statement-breakpoint
CREATE INDEX "idx_mission_plan_artifacts_company_mission_status"
ON "mission_plan_artifacts" ("company_id", "mission_id", "status");
--> statement-breakpoint
CREATE INDEX "idx_mission_plan_artifacts_mission_updated"
ON "mission_plan_artifacts" ("mission_id", "updated_at");
