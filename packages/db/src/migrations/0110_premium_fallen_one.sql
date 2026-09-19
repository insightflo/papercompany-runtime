CREATE TABLE "workflow_terminal_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"decided_authority_version" integer NOT NULL,
	"decision" text NOT NULL,
	"policy_cause" text NOT NULL,
	"discovery_path" text NOT NULL,
	"origin" text NOT NULL,
	"reason" text,
	"recovery_gate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_stop_targets" jsonb DEFAULT '{"runtimeIds":[],"heartbeatRunIds":[],"supersededUnblockIssueIds":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_terminal_effect_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"terminal_decision_id" uuid NOT NULL,
	"effect_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workflow_terminal_decisions" ADD CONSTRAINT "workflow_terminal_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_terminal_decisions" ADD CONSTRAINT "workflow_terminal_decisions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_terminal_effect_intents" ADD CONSTRAINT "workflow_terminal_effect_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_terminal_effect_intents" ADD CONSTRAINT "workflow_terminal_effect_intents_terminal_decision_id_workflow_terminal_decisions_id_fk" FOREIGN KEY ("terminal_decision_id") REFERENCES "public"."workflow_terminal_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_terminal_decisions_run_version_uq" ON "workflow_terminal_decisions" USING btree ("company_id","workflow_run_id","decided_authority_version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_terminal_effect_intents_target_uq" ON "workflow_terminal_effect_intents" USING btree ("terminal_decision_id","effect_kind","target_id");--> statement-breakpoint
CREATE INDEX "workflow_terminal_effect_intents_company_status_created_idx" ON "workflow_terminal_effect_intents" USING btree ("company_id","status","created_at");