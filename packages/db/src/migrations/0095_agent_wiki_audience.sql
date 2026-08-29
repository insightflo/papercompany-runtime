ALTER TABLE "agent_wiki_entries" ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'ops';
--> statement-breakpoint
UPDATE "agent_wiki_entries" SET "audience" = 'agent' WHERE "audience" = 'ops' AND "error_code" IN ('step_input_manifest_guardrail', 'workproduct_registration_missing', 'workproduct_path_outside_allowed_root');
