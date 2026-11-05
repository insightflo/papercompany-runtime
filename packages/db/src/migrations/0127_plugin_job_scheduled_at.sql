ALTER TABLE "plugin_job_runs" ADD COLUMN "scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "scheduled_cron" text;
--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "completion_uncertainty" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_job_runs_scheduled_slot_idx" ON "plugin_job_runs" USING btree ("job_id","scheduled_at") WHERE "plugin_job_runs"."trigger" = 'schedule' and "plugin_job_runs"."scheduled_at" is not null;
