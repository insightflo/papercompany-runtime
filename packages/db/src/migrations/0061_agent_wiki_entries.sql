-- Agent self-learning wiki: 반복 실패 패턴 축적 테이블.
-- 0060 마커 스타일(statement-breakpoint) + 인라인 FK 제약 + IF NOT EXISTS(멱등).
-- dedup unique index (company_id, agent_id, pattern, error_code)는
-- server/src/services/agent-wiki.ts recordFailure()의 onConflictDoUpdate target과 1:1 일치.
CREATE TABLE IF NOT EXISTS "agent_wiki_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "mission_id" uuid,
  "pattern" text NOT NULL,
  "cause" text NOT NULL,
  "solution" text NOT NULL,
  "error_code" text,
  "step_id" text,
  "frequency" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_wiki_entries_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade,
  CONSTRAINT "agent_wiki_entries_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade,
  CONSTRAINT "agent_wiki_entries_mission_id_missions_id_fk"
    FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wiki_entries_company_agent_pattern_code_key"
  ON "agent_wiki_entries" ("company_id", "agent_id", "pattern", "error_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wiki_entries_company_agent_status_idx"
  ON "agent_wiki_entries" ("company_id", "agent_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wiki_entries_company_pattern_idx"
  ON "agent_wiki_entries" ("company_id", "pattern");
