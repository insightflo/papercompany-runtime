CREATE TABLE "workflow_run_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_run_id" uuid NOT NULL,
	"target_step_run_id" uuid NOT NULL,
	"target_step_id" text NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_step_run_id" uuid NOT NULL,
	"source_step_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_run_seeds" ADD CONSTRAINT "workflow_run_seeds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_seeds" ADD CONSTRAINT "workflow_run_seeds_target_run_id_workflow_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_seeds" ADD CONSTRAINT "workflow_run_seeds_source_run_id_workflow_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_seeds" ADD CONSTRAINT "workflow_run_seeds_source_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("source_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_seeds_target_step_idx" ON "workflow_run_seeds" USING btree ("target_run_id","target_step_id");