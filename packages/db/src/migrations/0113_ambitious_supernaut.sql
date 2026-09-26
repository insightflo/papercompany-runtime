ALTER TABLE "issues" ADD COLUMN "last_operator_instruction_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_operator_instruction_comment_id" uuid;