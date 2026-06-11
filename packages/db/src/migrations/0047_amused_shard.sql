CREATE TABLE "workflow_run_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_definition_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger_source" text DEFAULT 'schedule' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"run_date" text,
	"timezone" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "schedule" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "deadline_time" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "last_scheduled_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "last_schedule_error" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "last_schedule_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "max_daily_runs" integer;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "max_concurrent_runs" integer;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "trigger_labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "create_parent_issue_policy" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "execution_mode" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "dynamic_plan_bootstrap_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "legacy_plugin_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "legacy_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "original_status" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "trigger_source" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "run_date" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "run_number" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "run_label" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "parent_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "scheduled_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "legacy_plugin_run_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "original_status" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "last_dispatch_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "last_dispatch_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "last_dispatch_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "last_dispatch_error_summary" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "last_dispatch_request_id" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "legacy_plugin_step_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_slots" ADD CONSTRAINT "workflow_run_slots_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_slots" ADD CONSTRAINT "workflow_run_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_slots_workflow_trigger_scheduled_at_uq" ON "workflow_run_slots" USING btree ("workflow_definition_id","trigger_source","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_run_slots_company_trigger_scheduled_at" ON "workflow_run_slots" USING btree ("company_id","trigger_source","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_run_slots_workflow_status" ON "workflow_run_slots" USING btree ("workflow_definition_id","status");--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_scheduled_slot_id_workflow_run_slots_id_fk" FOREIGN KEY ("scheduled_slot_id") REFERENCES "public"."workflow_run_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_definitions_status" ON "workflow_definitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_definitions_schedule" ON "workflow_definitions" USING btree ("company_id","status","schedule");--> statement-breakpoint
CREATE INDEX "idx_workflow_definitions_legacy_plugin_entity_id" ON "workflow_definitions" USING btree ("legacy_plugin_entity_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_company_trigger_source" ON "workflow_runs" USING btree ("company_id","trigger_source");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_parent_issue_id" ON "workflow_runs" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_legacy_plugin_run_entity_id" ON "workflow_runs" USING btree ("legacy_plugin_run_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_scheduled_slot_id_uq" ON "workflow_runs" USING btree ("scheduled_slot_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_step_runs_legacy_plugin_step_entity_id" ON "workflow_step_runs" USING btree ("legacy_plugin_step_entity_id");