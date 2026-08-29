CREATE TABLE IF NOT EXISTS "company_knowledge_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symptoms" text,
	"root_cause" text,
	"what_worked" text,
	"scope_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text NOT NULL,
	"created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_knowledge_patterns_company_kind_idx" ON "company_knowledge_patterns" ("company_id","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_knowledge_patterns_company_created_idx" ON "company_knowledge_patterns" ("company_id","created_at");
