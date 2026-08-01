ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "status_transition_version" integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION "paperclip_increment_workflow_step_run_status_transition_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."status_transition_version" := OLD."status_transition_version" + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "workflow_step_runs_status_transition_version" ON "workflow_step_runs";
CREATE TRIGGER "workflow_step_runs_status_transition_version"
BEFORE UPDATE OF "status" ON "workflow_step_runs"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "paperclip_increment_workflow_step_run_status_transition_version"();
