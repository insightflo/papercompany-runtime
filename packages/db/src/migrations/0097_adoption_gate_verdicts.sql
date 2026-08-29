CREATE TABLE IF NOT EXISTS "adoption_gate_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"gate_owner" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adoption_gate_verdicts_company_candidate_idx" ON "adoption_gate_verdicts" ("company_id","candidate_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adoption_gate_verdicts_company_gate_idx" ON "adoption_gate_verdicts" ("company_id","gate_owner");
