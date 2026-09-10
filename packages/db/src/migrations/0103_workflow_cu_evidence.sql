CREATE TABLE "workflow_cu_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"step_run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"spec_sha256" text NOT NULL,
	"job" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_cu_jobs_generation_check" CHECK ("workflow_cu_jobs"."execution_generation" >= 0),
	CONSTRAINT "workflow_cu_jobs_hash_check" CHECK ("workflow_cu_jobs"."spec_sha256" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
CREATE TABLE "workflow_cu_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observer_id" text NOT NULL,
	"observation_kind" text NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"screenshot_base64" text NOT NULL,
	"screenshot_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_cu_observations_revision_check" CHECK ("workflow_cu_observations"."revision" > 0),
	CONSTRAINT "workflow_cu_observations_kind_check" CHECK ("workflow_cu_observations"."kind" in ('provenance', 'credit', 'budget')),
	CONSTRAINT "workflow_cu_observations_observation_check" CHECK ("workflow_cu_observations"."observation_kind" = 'computer_use_observation'),
	CONSTRAINT "workflow_cu_observations_hash_check" CHECK ("workflow_cu_observations"."screenshot_sha256" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD COLUMN "cu_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD COLUMN "cu_snapshot_base64" text;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD COLUMN "cu_snapshot_sha256" text;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD COLUMN "cu_result_base64" text;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD COLUMN "cu_result_sha256" text;
--> statement-breakpoint
ALTER TABLE "workflow_cu_jobs" ADD CONSTRAINT "workflow_cu_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_jobs" ADD CONSTRAINT "workflow_cu_jobs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_jobs" ADD CONSTRAINT "workflow_cu_jobs_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_jobs" ADD CONSTRAINT "workflow_cu_jobs_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_jobs" ADD CONSTRAINT "workflow_cu_jobs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_observations" ADD CONSTRAINT "workflow_cu_observations_job_id_workflow_cu_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."workflow_cu_jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_cu_observations" ADD CONSTRAINT "workflow_cu_observations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_cu_jobs_scope_uq" ON "workflow_cu_jobs" USING btree ("company_id","step_run_id","execution_generation","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_cu_observations_record_uq" ON "workflow_cu_observations" USING btree ("company_id","job_id","record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_cu_observations_revision_uq" ON "workflow_cu_observations" USING btree ("job_id","revision");
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_cu_job_id_workflow_cu_jobs_id_fk" FOREIGN KEY ("cu_job_id") REFERENCES "public"."workflow_cu_jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Custom invariant supplement to the generated Drizzle DDL: append-only controller authority.
CREATE FUNCTION workflow_cu_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cu_record_immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workflow_cu_jobs_immutable BEFORE UPDATE OR DELETE ON workflow_cu_jobs
FOR EACH ROW EXECUTE FUNCTION workflow_cu_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_cu_observations_immutable BEFORE UPDATE OR DELETE ON workflow_cu_observations
FOR EACH ROW EXECUTE FUNCTION workflow_cu_reject_mutation();
--> statement-breakpoint
CREATE FUNCTION workflow_cu_submission_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cu_job_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cu_submission_immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.cu_job_id, NEW.cu_snapshot_base64, NEW.cu_snapshot_sha256,
         NEW.company_id, NEW.mission_id, NEW.workflow_run_id, NEW.step_run_id, NEW.issue_id,
         NEW.execution_generation, NEW.spec_sha256, NEW.manifest_object, NEW.manifest_sha256,
         NEW.request_hash, NEW.idempotency_key)
     IS DISTINCT FROM
     ROW(OLD.cu_job_id, OLD.cu_snapshot_base64, OLD.cu_snapshot_sha256,
         OLD.company_id, OLD.mission_id, OLD.workflow_run_id, OLD.step_run_id, OLD.issue_id,
         OLD.execution_generation, OLD.spec_sha256, OLD.manifest_object, OLD.manifest_sha256,
         OLD.request_hash, OLD.idempotency_key)
     OR (OLD.cu_result_base64 IS NOT NULL AND
         ROW(NEW.cu_result_base64, NEW.cu_result_sha256) IS DISTINCT FROM ROW(OLD.cu_result_base64, OLD.cu_result_sha256)) THEN
    RAISE EXCEPTION 'cu_submission_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workflow_cu_submission_pins BEFORE UPDATE OR DELETE ON workflow_late_evidence_submissions
FOR EACH ROW EXECUTE FUNCTION workflow_cu_submission_pins();
