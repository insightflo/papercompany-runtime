ALTER TABLE "workflow_qa_rebind_claims" ADD COLUMN "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_qa_rebind_claims" ADD CONSTRAINT "workflow_qa_rebind_claims_recovery_attempts_check" CHECK ("workflow_qa_rebind_claims"."recovery_attempts" >= 0);
