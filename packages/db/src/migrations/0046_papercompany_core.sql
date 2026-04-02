-- Migration: papercompany core tables
-- Created: 2026-04-01
-- Author: papercompany architecture team
-- Description: Add 17 new tables for papercompany core features (missions, workflow, tools, knowledge, scheduler, worktree, SRB, channel)
-- Rollback: See ROLLBACK section below

-- ===== UP =====

-- ============================================
-- 1. ALTER companies table
-- ============================================
ALTER TABLE "companies"
  ADD COLUMN "company_kind" TEXT NOT NULL DEFAULT 'business'
    CHECK (company_kind IN ('business', 'maintenance'));

ALTER TABLE "companies"
  ADD COLUMN "allows_code_modify" BOOLEAN NOT NULL DEFAULT false;

-- ============================================
-- 2. Missions and Mission Agents
-- ============================================
CREATE TABLE "missions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "owner_agent_id" uuid NOT NULL REFERENCES "agents"(id),
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'active', 'paused', 'completed', 'cancelled')),
  "goal_id" uuid REFERENCES "goals"(id) ON DELETE SET NULL,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "mission_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mission_id" uuid NOT NULL REFERENCES "missions"(id) ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"(id) ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'executor'
    CHECK (role IN ('executor', 'reviewer', 'observer')),
  "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mission_id, agent_id)
);

CREATE TABLE "mission_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mission_id" uuid NOT NULL REFERENCES "missions"(id) ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"(id) ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"(id),
  "session_secret_id" uuid NOT NULL REFERENCES "company_secrets"(id),
  "adapter_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'compacting', 'closed', 'expired')),
  "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "run_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mission_id, agent_id, adapter_type)
);

-- ============================================
-- 3. Workflow Tables
-- ============================================
CREATE TABLE "workflow_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "steps_json" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflow_definitions"(id) ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"(id),
  "mission_id" uuid REFERENCES "missions"(id) ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  "triggered_by" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "workflow_step_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"(id) ON DELETE CASCADE,
  "step_id" TEXT NOT NULL,
  "issue_id" uuid REFERENCES "issues"(id) ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ
);

-- ============================================
-- 4. Tool Tables
-- ============================================
CREATE TABLE "tool_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "input_schema" JSONB NOT NULL DEFAULT '{}',
  "adapter_type" TEXT NOT NULL,
  "adapter_config" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE "tool_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tool_id" uuid NOT NULL REFERENCES "tool_definitions"(id) ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"(id),
  "issue_id" uuid REFERENCES "issues"(id) ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agents"(id) ON DELETE SET NULL,
  "args_hash" TEXT NOT NULL,
  "result" TEXT NOT NULL
    CHECK (result IN ('allowed', 'blocked_must', 'blocked_should')),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 5. Knowledge Base Tables
-- ============================================
CREATE TABLE "knowledge_bases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL
    CHECK (type IN ('static', 'rag', 'ontology')),
  "description" TEXT NOT NULL DEFAULT '',
  "max_token_budget" INTEGER NOT NULL DEFAULT 4096,
  "config_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE "agent_kb_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"(id) ON DELETE CASCADE,
  "kb_id" uuid NOT NULL REFERENCES "knowledge_bases"(id) ON DELETE CASCADE,
  "granted_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kb_id)
);

-- ============================================
-- 6. Scheduler Tables
-- ============================================
CREATE TABLE "schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"(id) ON DELETE CASCADE,
  "cron_expression" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "mission_id" uuid REFERENCES "missions"(id) ON DELETE SET NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "last_run_at" TIMESTAMPTZ,
  "next_run_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 7. Worktree Tables
-- ============================================
CREATE TABLE "worktree_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "severity" TEXT NOT NULL
    CHECK (severity IN ('MUST', 'SHOULD', 'MAY')),
  "action" TEXT NOT NULL,
  "predicate" JSONB NOT NULL DEFAULT '{}',
  "decision_map" JSONB NOT NULL DEFAULT '{}',
  "message" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "worktree_rule_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" uuid REFERENCES "worktree_rules"(id) ON DELETE SET NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "proposed_by" TEXT NOT NULL,
  "proposed_change" JSONB NOT NULL,
  "rationale" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'rejected')),
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "worktree_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" uuid REFERENCES "worktree_rules"(id) ON DELETE SET NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"(id),
  "agent_id" uuid REFERENCES "agents"(id) ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"(id) ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "result" TEXT NOT NULL
    CHECK (result IN ('allowed', 'warned', 'blocked')),
  "context_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 8. SRB Tables
-- ============================================
CREATE TABLE "srb_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "local_company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "remote_company_id" TEXT NOT NULL,
  "remote_server_url" TEXT,
  "direction" TEXT NOT NULL,
  "shared_secret_id" uuid REFERENCES "company_secrets"(id) ON DELETE SET NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "srb_delivery_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "link_id" uuid NOT NULL REFERENCES "srb_links"(id) ON DELETE CASCADE,
  "event" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ,
  "next_retry_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "srb_nonces" (
  "idempotency_key" TEXT PRIMARY KEY,
  "link_id" uuid NOT NULL REFERENCES "srb_links"(id) ON DELETE CASCADE,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 9. Channel Tables
-- ============================================
CREATE TABLE "channel_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
  "kind" TEXT NOT NULL DEFAULT 'telegram',
  "config_json" JSONB NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind)
);

-- ============================================
-- 10. Indexes
-- ============================================

-- Missions indexes
CREATE INDEX "idx_missions_company_id" ON "missions" ("company_id");
CREATE INDEX "idx_missions_owner_agent_id" ON "missions" ("owner_agent_id");
CREATE INDEX "idx_missions_status" ON "missions" ("status");
CREATE INDEX "idx_missions_goal_id" ON "missions" ("goal_id");

-- Mission agents indexes
CREATE INDEX "idx_mission_agents_mission_id" ON "mission_agents" ("mission_id");
CREATE INDEX "idx_mission_agents_agent_id" ON "mission_agents" ("agent_id");

-- Mission sessions indexes
CREATE INDEX "idx_mission_sessions_mission_id" ON "mission_sessions" ("mission_id");
CREATE INDEX "idx_mission_sessions_company_id_status" ON "mission_sessions" ("company_id", "status")
  WHERE "status" = 'active';
CREATE INDEX "idx_mission_sessions_agent_id" ON "mission_sessions" ("agent_id");

-- Workflow definitions indexes
CREATE INDEX "idx_workflow_definitions_company_id" ON "workflow_definitions" ("company_id");

-- Workflow runs indexes
CREATE INDEX "idx_workflow_runs_workflow_id" ON "workflow_runs" ("workflow_id");
CREATE INDEX "idx_workflow_runs_company_id_mission_id" ON "workflow_runs" ("company_id", "mission_id");
CREATE INDEX "idx_workflow_runs_status" ON "workflow_runs" ("status");

-- Workflow step runs indexes
CREATE INDEX "idx_workflow_step_runs_workflow_run_id" ON "workflow_step_runs" ("workflow_run_id");
CREATE INDEX "idx_workflow_step_runs_issue_id" ON "workflow_step_runs" ("issue_id");

-- Tool definitions indexes
CREATE INDEX "idx_tool_definitions_company_id" ON "tool_definitions" ("company_id");

-- Tool audit log indexes
CREATE INDEX "idx_tool_audit_log_tool_id" ON "tool_audit_log" ("tool_id");
CREATE INDEX "idx_tool_audit_log_company_id" ON "tool_audit_log" ("company_id");
CREATE INDEX "idx_tool_audit_log_agent_id" ON "tool_audit_log" ("agent_id");

-- Knowledge bases indexes
CREATE INDEX "idx_knowledge_bases_company_id" ON "knowledge_bases" ("company_id");

-- Agent KB grants indexes
CREATE INDEX "idx_agent_kb_grants_agent_id" ON "agent_kb_grants" ("agent_id");
CREATE INDEX "idx_agent_kb_grants_kb_id" ON "agent_kb_grants" ("kb_id");

-- Schedules indexes
CREATE INDEX "idx_schedules_company_id" ON "schedules" ("company_id");
CREATE INDEX "idx_schedules_agent_id" ON "schedules" ("agent_id");
CREATE INDEX "idx_schedules_next_run_at" ON "schedules" ("next_run_at")
  WHERE "enabled" = true;
CREATE INDEX "idx_schedules_company_id_next_run_at" ON "schedules" ("company_id", "next_run_at")
  WHERE "enabled" = true;

-- Worktree rules indexes
CREATE INDEX "idx_worktree_rules_company_id" ON "worktree_rules" ("company_id");

-- Worktree rule proposals indexes
CREATE INDEX "idx_worktree_rule_proposals_rule_id" ON "worktree_rule_proposals" ("rule_id");
CREATE INDEX "idx_worktree_rule_proposals_company_id" ON "worktree_rule_proposals" ("company_id");
CREATE INDEX "idx_worktree_rule_proposals_status" ON "worktree_rule_proposals" ("status");

-- Worktree audit log indexes
CREATE INDEX "idx_worktree_audit_log_company_id_created_at" ON "worktree_audit_log" ("company_id", "created_at" DESC);
CREATE INDEX "idx_worktree_audit_log_agent_id" ON "worktree_audit_log" ("agent_id");
CREATE INDEX "idx_worktree_audit_log_issue_id" ON "worktree_audit_log" ("issue_id");

-- SRB links indexes
CREATE INDEX "idx_srb_links_local_company_id" ON "srb_links" ("local_company_id");

-- SRB delivery log indexes
CREATE INDEX "idx_srb_delivery_log_link_id" ON "srb_delivery_log" ("link_id");
CREATE INDEX "idx_srb_delivery_log_status_next_retry_at" ON "srb_delivery_log" ("status", "next_retry_at")
  WHERE "status" IN ('pending', 'failed');

-- SRB nonces indexes
CREATE INDEX "idx_srb_nonces_link_id" ON "srb_nonces" ("link_id");
CREATE INDEX "idx_srb_nonces_received_at" ON "srb_nonces" ("received_at");

-- Channel configs indexes
CREATE INDEX "idx_channel_configs_company_id" ON "channel_configs" ("company_id");

-- ===== ROLLBACK (Reference Only) =====
-- To rollback this migration, execute the following in order:
--
-- DROP INDEX IF EXISTS "idx_channel_configs_company_id";
-- DROP INDEX IF EXISTS "idx_srb_nonces_received_at";
-- DROP INDEX IF EXISTS "idx_srb_nonces_link_id";
-- DROP INDEX IF EXISTS "idx_srb_delivery_log_status_next_retry_at";
-- DROP INDEX IF EXISTS "idx_srb_delivery_log_link_id";
-- DROP INDEX IF EXISTS "idx_srb_links_local_company_id";
-- DROP INDEX IF EXISTS "idx_worktree_audit_log_issue_id";
-- DROP INDEX IF EXISTS "idx_worktree_audit_log_agent_id";
-- DROP INDEX IF EXISTS "idx_worktree_audit_log_company_id_created_at";
-- DROP INDEX IF EXISTS "idx_worktree_rule_proposals_status";
-- DROP INDEX IF EXISTS "idx_worktree_rule_proposals_company_id";
-- DROP INDEX IF EXISTS "idx_worktree_rule_proposals_rule_id";
-- DROP INDEX IF EXISTS "idx_worktree_rules_company_id";
-- DROP INDEX IF EXISTS "idx_schedules_company_id_next_run_at";
-- DROP INDEX IF EXISTS "idx_schedules_next_run_at";
-- DROP INDEX IF EXISTS "idx_schedules_agent_id";
-- DROP INDEX IF EXISTS "idx_schedules_company_id";
-- DROP INDEX IF EXISTS "idx_agent_kb_grants_kb_id";
-- DROP INDEX IF EXISTS "idx_agent_kb_grants_agent_id";
-- DROP INDEX IF EXISTS "idx_knowledge_bases_company_id";
-- DROP INDEX IF EXISTS "idx_tool_audit_log_agent_id";
-- DROP INDEX IF EXISTS "idx_tool_audit_log_company_id";
-- DROP INDEX IF EXISTS "idx_tool_audit_log_tool_id";
-- DROP INDEX IF EXISTS "idx_tool_definitions_company_id";
-- DROP INDEX IF EXISTS "idx_workflow_step_runs_issue_id";
-- DROP INDEX IF EXISTS "idx_workflow_step_runs_workflow_run_id";
-- DROP INDEX IF EXISTS "idx_workflow_runs_status";
-- DROP INDEX IF EXISTS "idx_workflow_runs_company_id_mission_id";
-- DROP INDEX IF EXISTS "idx_workflow_runs_workflow_id";
-- DROP INDEX IF EXISTS "idx_workflow_definitions_company_id";
-- DROP INDEX IF EXISTS "idx_mission_sessions_agent_id";
-- DROP INDEX IF EXISTS "idx_mission_sessions_company_id_status";
-- DROP INDEX IF EXISTS "idx_mission_sessions_mission_id";
-- DROP INDEX IF EXISTS "idx_mission_agents_agent_id";
-- DROP INDEX IF EXISTS "idx_mission_agents_mission_id";
-- DROP INDEX IF EXISTS "idx_missions_goal_id";
-- DROP INDEX IF EXISTS "idx_missions_status";
-- DROP INDEX IF EXISTS "idx_missions_owner_agent_id";
-- DROP INDEX IF EXISTS "idx_missions_company_id";
--
-- DROP TABLE IF EXISTS "channel_configs" CASCADE;
-- DROP TABLE IF EXISTS "srb_nonces" CASCADE;
-- DROP TABLE IF EXISTS "srb_delivery_log" CASCADE;
-- DROP TABLE IF EXISTS "srb_links" CASCADE;
-- DROP TABLE IF EXISTS "worktree_audit_log" CASCADE;
-- DROP TABLE IF EXISTS "worktree_rule_proposals" CASCADE;
-- DROP TABLE IF EXISTS "worktree_rules" CASCADE;
-- DROP TABLE IF EXISTS "schedules" CASCADE;
-- DROP TABLE IF EXISTS "agent_kb_grants" CASCADE;
-- DROP TABLE IF EXISTS "knowledge_bases" CASCADE;
-- DROP TABLE IF EXISTS "tool_audit_log" CASCADE;
-- DROP TABLE IF EXISTS "tool_definitions" CASCADE;
-- DROP TABLE IF EXISTS "workflow_step_runs" CASCADE;
-- DROP TABLE IF EXISTS "workflow_runs" CASCADE;
-- DROP TABLE IF EXISTS "workflow_definitions" CASCADE;
-- DROP TABLE IF EXISTS "mission_sessions" CASCADE;
-- DROP TABLE IF EXISTS "mission_agents" CASCADE;
-- DROP TABLE IF EXISTS "missions" CASCADE;
--
-- ALTER TABLE "companies" DROP COLUMN IF EXISTS "allows_code_modify";
-- ALTER TABLE "companies" DROP COLUMN IF EXISTS "company_kind";
