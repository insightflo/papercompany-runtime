CREATE TABLE "workflow_recovery_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"target_authority_version" integer NOT NULL,
	"target_decision_id" uuid NOT NULL,
	"recovery_kind" text NOT NULL,
	"request_reference" text,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'consumed' NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resulting_authority_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_target_decision_id_workflow_terminal_decisions_id_fk" FOREIGN KEY ("target_decision_id") REFERENCES "public"."workflow_terminal_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_authorities_run_version_uq" ON "workflow_recovery_authorities" USING btree ("company_id","workflow_run_id","target_authority_version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_authorities_kind_reference_uq" ON "workflow_recovery_authorities" USING btree ("company_id","workflow_run_id","recovery_kind","request_reference","target_authority_version");