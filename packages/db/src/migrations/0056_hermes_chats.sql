CREATE TABLE IF NOT EXISTS "hermes_chat_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid,
  "title" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" text,
  "last_message_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hermes_chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "agent_id" uuid,
  "run_id" uuid,
  "role" text NOT NULL,
  "body" text NOT NULL,
  "status" text DEFAULT 'sent' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "hermes_chat_sessions" ADD CONSTRAINT "hermes_chat_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "hermes_chat_sessions" ADD CONSTRAINT "hermes_chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "hermes_chat_messages" ADD CONSTRAINT "hermes_chat_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "hermes_chat_messages" ADD CONSTRAINT "hermes_chat_messages_session_id_hermes_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "hermes_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "hermes_chat_messages" ADD CONSTRAINT "hermes_chat_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "hermes_chat_messages" ADD CONSTRAINT "hermes_chat_messages_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "hermes_chat_sessions_company_updated_idx" ON "hermes_chat_sessions" ("company_id", "updated_at");
CREATE INDEX IF NOT EXISTS "hermes_chat_sessions_company_status_updated_idx" ON "hermes_chat_sessions" ("company_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "hermes_chat_messages_session_created_idx" ON "hermes_chat_messages" ("session_id", "created_at");
CREATE INDEX IF NOT EXISTS "hermes_chat_messages_company_created_idx" ON "hermes_chat_messages" ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "hermes_chat_messages_run_idx" ON "hermes_chat_messages" ("run_id");
