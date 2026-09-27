CREATE TABLE "plugin_tool_execution_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"tool" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"request_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_status" integer,
	"result_body" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"workflow_run_id" uuid,
	"step_id" text,
	CONSTRAINT "plugin_tool_execution_receipts_status_check" CHECK ("plugin_tool_execution_receipts"."status" in ('executing', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "plugin_tool_execution_receipts" ADD CONSTRAINT "plugin_tool_execution_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_tool_execution_receipts_company_idx" ON "plugin_tool_execution_receipts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_tool_execution_receipts_identity_uq" ON "plugin_tool_execution_receipts" USING btree ("company_id","run_id","tool","idempotency_key");