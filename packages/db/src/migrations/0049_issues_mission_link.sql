ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "mission_id" uuid REFERENCES "missions"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "issues_company_mission_idx"
  ON "issues" ("company_id", "mission_id");
