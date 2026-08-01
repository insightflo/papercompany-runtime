-- Workflow and heartbeat authority/finalization Phase B: deterministic legacy backfill.
-- This migration only fills legacy-safe fields. It never grants authority, acknowledges
-- an executor, creates finalization work, proves quiescence, or settles a heartbeat.

DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "heartbeat_runs"
      WHERE "execution_token" IS NULL
      ORDER BY id
      LIMIT batch_size
    )
    UPDATE "heartbeat_runs" AS heartbeat
    SET "execution_token" = gen_random_uuid()
    FROM batch
    WHERE heartbeat.id = batch.id
      AND heartbeat."execution_token" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 heartbeat_runs.execution_token backfilled % rows', updated_rows;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "heartbeat_runs"
      WHERE "execution_epoch" IS NULL
      ORDER BY id
      LIMIT batch_size
    )
    UPDATE "heartbeat_runs" AS heartbeat
    SET "execution_epoch" = 0
    FROM batch
    WHERE heartbeat.id = batch.id
      AND heartbeat."execution_epoch" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 heartbeat_runs.execution_epoch backfilled % rows', updated_rows;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "heartbeat_runs"
      WHERE "execution_scope_kind" IS NULL
      ORDER BY id
      LIMIT batch_size
    )
    UPDATE "heartbeat_runs" AS heartbeat
    SET "execution_scope_kind" = 'legacy'
    FROM batch
    WHERE heartbeat.id = batch.id
      AND heartbeat."execution_scope_kind" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 heartbeat_runs.execution_scope_kind backfilled % rows', updated_rows;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT delegation.id
      FROM "workflow_delegations" AS delegation
      JOIN "workflow_step_runs" AS source_step
        ON source_step.id = delegation."source_workflow_step_run_id"
       AND source_step."workflow_run_id" = delegation."source_workflow_run_id"
      WHERE delegation."source_execution_generation" IS NULL
        AND source_step."dispatch_authority_kind" = 'legacy'
        AND source_step."execution_generation" = 0
      ORDER BY delegation.id
      LIMIT batch_size
    )
    UPDATE "workflow_delegations" AS delegation
    SET "source_execution_generation" = 0
    FROM batch
    WHERE delegation.id = batch.id
      AND delegation."source_execution_generation" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 workflow_delegations.source_execution_generation backfilled % rows', updated_rows;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "workflow_step_runs"
      WHERE "dispatch_authority_kind" IS NULL
      ORDER BY id
      LIMIT batch_size
    )
    UPDATE "workflow_step_runs" AS step_run
    SET "dispatch_authority_kind" = 'legacy'
    FROM batch
    WHERE step_run.id = batch.id
      AND step_run."dispatch_authority_kind" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 workflow_step_runs.dispatch_authority_kind backfilled % rows', updated_rows;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  batch_size CONSTANT integer := 1000;
  updated_rows integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM "workflow_step_runs"
      WHERE "execution_generation" IS NULL
      ORDER BY id
      LIMIT batch_size
    )
    UPDATE "workflow_step_runs" AS step_run
    SET "execution_generation" = 0
    FROM batch
    WHERE step_run.id = batch.id
      AND step_run."execution_generation" IS NULL;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
    RAISE NOTICE '0084 workflow_step_runs.execution_generation backfilled % rows', updated_rows;
  END LOOP;
END $$;
