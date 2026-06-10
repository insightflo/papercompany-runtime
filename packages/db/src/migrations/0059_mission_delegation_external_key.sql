ALTER TABLE "mission_delegations"
  ADD COLUMN IF NOT EXISTS "external_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "mission_delegations_source_external_key_uq"
  ON "mission_delegations" ("source_mission_id", "external_key");
