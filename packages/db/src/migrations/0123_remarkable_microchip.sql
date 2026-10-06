CREATE TABLE "workflow_qa_rebind_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"consumer_step_run_id" uuid NOT NULL,
	"consumer_step_id" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"reason_code" text,
	"expected_digests" jsonb,
	"authority_version" integer NOT NULL,
	"execution_generation" integer NOT NULL,
	"request_id" text,
	"claimed_at" timestamp with time zone,
	"authority_id" uuid,
	"classified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_qa_rebind_claims_status_check" CHECK ("workflow_qa_rebind_claims"."status" in
    ('candidate','auto_eligible','card_required','blocked','excluded','claimed','recovered','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "workflow_qa_rebind_claims" ADD CONSTRAINT "workflow_qa_rebind_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_qa_rebind_claims" ADD CONSTRAINT "workflow_qa_rebind_claims_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_qa_rebind_claims" ADD CONSTRAINT "workflow_qa_rebind_claims_consumer_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("consumer_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_qa_rebind_claims" ADD CONSTRAINT "workflow_qa_rebind_claims_authority_id_workflow_recovery_authorities_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."workflow_recovery_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_qa_rebind_claims_bundle_uq" ON "workflow_qa_rebind_claims" USING btree ("company_id","workflow_run_id","consumer_step_id","bundle_digest");--> statement-breakpoint
CREATE INDEX "workflow_qa_rebind_claims_company_status_idx" ON "workflow_qa_rebind_claims" USING btree ("company_id","status");