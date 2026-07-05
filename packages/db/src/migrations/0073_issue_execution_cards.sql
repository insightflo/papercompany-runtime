CREATE TABLE "agent_instruction_injections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "adapter_type" text NOT NULL,
  "instructions_path" text NOT NULL,
  "content_hash" text NOT NULL,
  "injection_count" integer DEFAULT 1 NOT NULL,
  "last_injection_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_execution_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "mission_id" uuid,
  "workflow_run_id" uuid,
  "workflow_step_run_id" uuid,
  "card_version" integer DEFAULT 1 NOT NULL,
  "content_hash" text NOT NULL,
  "card_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_issue_handoffs" ADD COLUMN "content_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_instruction_injections"
  ADD CONSTRAINT "agent_instruction_injections_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instruction_injections"
  ADD CONSTRAINT "agent_instruction_injections_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instruction_injections"
  ADD CONSTRAINT "agent_instruction_injections_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_execution_cards"
  ADD CONSTRAINT "issue_execution_cards_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_execution_cards"
  ADD CONSTRAINT "issue_execution_cards_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_execution_cards"
  ADD CONSTRAINT "issue_execution_cards_mission_id_missions_id_fk"
  FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_execution_cards"
  ADD CONSTRAINT "issue_execution_cards_workflow_run_id_workflow_runs_id_fk"
  FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_execution_cards"
  ADD CONSTRAINT "issue_execution_cards_workflow_step_run_id_workflow_step_runs_id_fk"
  FOREIGN KEY ("workflow_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instruction_injections_issue_agent_path_uq"
  ON "agent_instruction_injections" USING btree ("company_id","issue_id","agent_id","adapter_type","instructions_path");
--> statement-breakpoint
CREATE INDEX "idx_agent_instruction_injections_issue_updated"
  ON "agent_instruction_injections" USING btree ("company_id","issue_id","updated_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_instruction_injections_content_hash"
  ON "agent_instruction_injections" USING btree ("content_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_cards_company_issue_uq"
  ON "issue_execution_cards" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX "idx_issue_execution_cards_mission_updated"
  ON "issue_execution_cards" USING btree ("company_id","mission_id","updated_at");
--> statement-breakpoint
CREATE INDEX "idx_issue_execution_cards_workflow_run"
  ON "issue_execution_cards" USING btree ("workflow_run_id");
--> statement-breakpoint
CREATE INDEX "idx_issue_execution_cards_content_hash"
  ON "issue_execution_cards" USING btree ("content_hash");
--> statement-breakpoint
CREATE INDEX "idx_mission_issue_handoffs_content_hash"
  ON "mission_issue_handoffs" USING btree ("content_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_issue_handoffs_issue_status_hash_uq"
  ON "mission_issue_handoffs" USING btree ("company_id","issue_id","status","content_hash");
