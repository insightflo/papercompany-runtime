-- Agent Wiki Phase 3: SkillOpt-Sleep 자가진화 제안 추적 테이블.
-- 0060 마커 스타일(statement-breakpoint) + 인라인 FK + IF NOT EXISTS(멱등).
-- entry_id unique index 는 agent-skill-optimizer.ts upsertProposal 의 onConflict target 과 1:1.
CREATE TABLE IF NOT EXISTS "agent_wiki_edit_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entry_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "pattern" text NOT NULL,
  "status" text DEFAULT 'proposing' NOT NULL,
  "baseline_frequency" integer NOT NULL,
  "original_snapshot" text,
  "proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_wiki_edit_proposals_entry_id_agent_wiki_entries_id_fk"
    FOREIGN KEY ("entry_id") REFERENCES "agent_wiki_entries"("id") ON DELETE cascade,
  CONSTRAINT "agent_wiki_edit_proposals_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade,
  CONSTRAINT "agent_wiki_edit_proposals_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wiki_edit_proposals_entry_id_key"
  ON "agent_wiki_edit_proposals" ("entry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wiki_edit_proposals_agent_status_idx"
  ON "agent_wiki_edit_proposals" ("agent_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wiki_edit_proposals_status_proposed_idx"
  ON "agent_wiki_edit_proposals" ("status", "proposed_at");
