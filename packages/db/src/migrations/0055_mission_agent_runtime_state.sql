CREATE TABLE "mission_agent_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"runtime_key" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"process_pid" integer,
	"session_id" text,
	"session_params_json" jsonb,
	"workspace_id" uuid,
	"workspace_key" text DEFAULT 'default' NOT NULL,
	"current_issue_id" uuid,
	"last_run_id" uuid,
	"last_run_status" text,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"context_bootstrap_version" integer DEFAULT 1 NOT NULL,
	"context_injected_at" timestamp with time zone,
	"last_issue_envelope_at" timestamp with time zone,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"stop_reason" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_issue_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"mission_session_id" uuid,
	"status" text NOT NULL,
	"handoff_version" integer DEFAULT 1 NOT NULL,
	"handoff_markdown" text NOT NULL,
	"handoff_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_rolling_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state_markdown" text DEFAULT '' NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_id" uuid,
	"last_compacted_at" timestamp with time zone,
	"total_runs" integer DEFAULT 0 NOT NULL,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_agent_runtimes" ADD CONSTRAINT "mission_agent_runtimes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_agent_runtimes" ADD CONSTRAINT "mission_agent_runtimes_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_agent_runtimes" ADD CONSTRAINT "mission_agent_runtimes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_agent_runtimes" ADD CONSTRAINT "mission_agent_runtimes_current_issue_id_issues_id_fk" FOREIGN KEY ("current_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_agent_runtimes" ADD CONSTRAINT "mission_agent_runtimes_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD CONSTRAINT "mission_issue_handoffs_mission_session_id_mission_sessions_id_fk" FOREIGN KEY ("mission_session_id") REFERENCES "public"."mission_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_rolling_state" ADD CONSTRAINT "mission_rolling_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_rolling_state" ADD CONSTRAINT "mission_rolling_state_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_rolling_state" ADD CONSTRAINT "mission_rolling_state_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_agent_runtimes_mission_agent_adapter_workspace_key" ON "mission_agent_runtimes" USING btree ("mission_id","agent_id","adapter_type","workspace_key");
--> statement-breakpoint
CREATE INDEX "idx_mission_agent_runtimes_company_status" ON "mission_agent_runtimes" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "idx_mission_agent_runtimes_mission_status" ON "mission_agent_runtimes" USING btree ("company_id","mission_id","status");
--> statement-breakpoint
CREATE INDEX "idx_mission_agent_runtimes_agent" ON "mission_agent_runtimes" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_mission_issue_handoffs_mission_created" ON "mission_issue_handoffs" USING btree ("company_id","mission_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_mission_issue_handoffs_issue_created" ON "mission_issue_handoffs" USING btree ("issue_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_mission_issue_handoffs_agent_mission" ON "mission_issue_handoffs" USING btree ("company_id","agent_id","mission_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_issue_handoffs_run_id_key" ON "mission_issue_handoffs" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_rolling_state_mission_id_key" ON "mission_rolling_state" USING btree ("mission_id");
--> statement-breakpoint
CREATE INDEX "idx_mission_rolling_state_company_status" ON "mission_rolling_state" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "idx_mission_rolling_state_company_updated" ON "mission_rolling_state" USING btree ("company_id","updated_at");
