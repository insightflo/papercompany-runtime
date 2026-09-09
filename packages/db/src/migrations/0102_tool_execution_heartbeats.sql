-- Generated with pnpm db:generate, restricted to this table because the legacy
-- Drizzle journal ends at 0047. Runtime applies the subsequent numbered SQL files.
CREATE TABLE "tool_execution_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"adapter_type" text NOT NULL,
	"policy" jsonb NOT NULL,
	"token_hash" text,
	"workflow_run_id" uuid,
	"step_run_id" uuid,
	"step_id" text,
	"execution_generation" integer,
	"retry_count" integer,
	"iteration_index" integer,
	"started_at" timestamp with time zone NOT NULL,
	"last_progress_at" timestamp with time zone NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"stage_index" integer DEFAULT -1 NOT NULL,
	"current" bigint DEFAULT 0 NOT NULL,
	"total" bigint,
	"state" text DEFAULT 'active' NOT NULL,
	"finished_at" timestamp with time zone,
	"reason" varchar(64),
	CONSTRAINT "tool_execution_heartbeats_state_ck" CHECK ("tool_execution_heartbeats"."state" in ('active','succeeded','failed','timed_out'))
);
--> statement-breakpoint
ALTER TABLE "tool_execution_heartbeats" ADD CONSTRAINT "tool_execution_heartbeats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_execution_heartbeats" ADD CONSTRAINT "tool_execution_heartbeats_tool_id_tool_definitions_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tool_definitions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_execution_heartbeats_company_execution_uq" ON "tool_execution_heartbeats" USING btree ("company_id","id");
--> statement-breakpoint
CREATE INDEX "tool_execution_heartbeats_company_started_idx" ON "tool_execution_heartbeats" USING btree ("company_id","started_at");
--> statement-breakpoint
CREATE INDEX "tool_execution_heartbeats_active_expiry_idx" ON "tool_execution_heartbeats" USING btree ("last_progress_at","started_at") WHERE "tool_execution_heartbeats"."state" = 'active';
