SELECT pg_advisory_xact_lock(920092001::bigint);
--> statement-breakpoint
ALTER TABLE "workflow_definitions"
  ADD COLUMN IF NOT EXISTS "mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_definitions"
  ADD COLUMN IF NOT EXISTS "definition_hash" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workflow_definitions_mission_id_missions_id_fk'
      AND conrelid = 'workflow_definitions'::regclass
  ) THEN
    ALTER TABLE "workflow_definitions"
      ADD CONSTRAINT "workflow_definitions_mission_id_missions_id_fk"
      FOREIGN KEY ("mission_id") REFERENCES "missions"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  violators integer;
BEGIN
  SELECT count(*) INTO violators
  FROM workflow_definitions d
  WHERE d.name LIKE 'PAQO WBS:%'
    AND (
      (SELECT count(*) FROM workflow_runs r WHERE r.workflow_id = d.id) = 0
      OR (
        SELECT count(DISTINCT r.mission_id)
        FROM workflow_runs r
        WHERE r.workflow_id = d.id AND r.mission_id IS NOT NULL
      ) <> 1
    );
  IF violators <> 0 THEN
    RAISE EXCEPTION '0092 guard violated: % PAQO legacy definition(s) named like ''PAQO WBS:%%'' do not resolve through workflow_runs to exactly one distinct non-null mission', violators;
  END IF;
END $$;
--> statement-breakpoint
UPDATE workflow_definitions d
SET mission_id = (
  SELECT min(r.mission_id::text)::uuid
  FROM workflow_runs r
  WHERE r.workflow_id = d.id AND r.mission_id IS NOT NULL
)
WHERE d.name LIKE 'PAQO WBS:%'
  AND d.mission_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved
  FROM workflow_definitions
  WHERE name LIKE 'PAQO WBS:%' AND mission_id IS NULL;
  IF unresolved <> 0 THEN
    RAISE EXCEPTION '0092 invariant violated: % PAQO legacy definition(s) still have null mission_id after backfill', unresolved;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_definitions_paqo_identity_uq"
  ON "workflow_definitions" ("company_id", "mission_id", "definition_hash")
  WHERE "source_kind" = 'paqo' AND "mission_id" IS NOT NULL AND "definition_hash" IS NOT NULL;
