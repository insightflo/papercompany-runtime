CREATE TABLE IF NOT EXISTS "mission_delegations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE cascade,
  "source_issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "target_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "target_mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE cascade,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_mission_delegations_source_mission"
  ON "mission_delegations" ("source_company_id", "source_mission_id");

CREATE INDEX IF NOT EXISTS "idx_mission_delegations_target_mission"
  ON "mission_delegations" ("target_company_id", "target_mission_id");

CREATE INDEX IF NOT EXISTS "idx_mission_delegations_status"
  ON "mission_delegations" ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "mission_delegations_target_mission_uq"
  ON "mission_delegations" ("target_mission_id");
