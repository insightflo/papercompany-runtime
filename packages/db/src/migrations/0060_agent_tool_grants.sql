CREATE TABLE IF NOT EXISTS "agent_tool_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "tool_id" uuid NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_tool_grants_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade,
  CONSTRAINT "agent_tool_grants_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade,
  CONSTRAINT "agent_tool_grants_tool_id_tool_definitions_id_fk"
    FOREIGN KEY ("tool_id") REFERENCES "tool_definitions"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_tool_grants_company_id"
  ON "agent_tool_grants" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_tool_grants_agent_id"
  ON "agent_tool_grants" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_tool_grants_tool_id"
  ON "agent_tool_grants" ("tool_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tool_grants_company_agent_tool_key"
  ON "agent_tool_grants" ("company_id", "agent_id", "tool_id");
