ALTER TABLE "judgment_calls" ADD COLUMN "state_original_hash" text;--> statement-breakpoint
ALTER TABLE "judgment_calls" ADD COLUMN "egress_status" text;--> statement-breakpoint
ALTER TABLE "judgment_calls" ADD COLUMN "egress_findings" jsonb;