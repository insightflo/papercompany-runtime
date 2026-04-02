-- Migration: papercompany additional partial indexes
-- Created: 2026-04-01
-- Author: papercompany architecture team
-- Description: Add useful partial indexes for observability and query performance
-- Rollback: See ROLLBACK section below

-- ===== UP =====

-- ============================================
-- 1. heartbeat_runs partial indexes
-- ============================================

-- Active heartbeat runs (queued or running) - heavily queried for queue display
CREATE INDEX "idx_heartbeat_runs_status_queued_running"
  ON "heartbeat_runs" ("created_at" DESC)
  WHERE "status" IN ('queued', 'running');

-- ============================================
-- 2. heartbeat_run_events partial indexes
-- ============================================

-- Run events by run_id for tailing a specific run
CREATE INDEX "idx_heartbeat_run_events_run_id_created_at"
  ON "heartbeat_run_events" ("run_id", "created_at" DESC);

-- ============================================
-- 3. worktree_audit_log partial indexes
-- ============================================

-- Recent audit entries by agent (for agent activity feed)
CREATE INDEX "idx_worktree_audit_log_agent_id_created_at"
  ON "worktree_audit_log" ("agent_id", "created_at" DESC);

-- Recent audit entries by issue (for issue activity feed)
CREATE INDEX "idx_worktree_audit_log_issue_id_created_at"
  ON "worktree_audit_log" ("issue_id", "created_at" DESC);

-- ============================================
-- 4. srb_nonces partial indexes
-- ============================================

CREATE INDEX "idx_srb_nonces_received_at_old"
  ON "srb_nonces" ("received_at" ASC);

-- ============================================
-- 5. activity_log partial indexes
-- ============================================

-- Recent activity by company (for activity feed)
CREATE INDEX "idx_activity_log_company_id_created_at"
  ON "activity_log" ("company_id", "created_at" DESC);

-- Activity by actor (agent or user)
CREATE INDEX "idx_activity_log_actor_type_actor_id_created_at"
  ON "activity_log" ("actor_type", "actor_id", "created_at" DESC);

-- ============================================
-- 6. issues partial indexes (beyond existing routine_execution partial index)
-- ============================================

-- Open issues by assignee (for personal queue)
CREATE INDEX "idx_issues_assignee_status_open"
  ON "issues" ("assignee_agent_id", "updated_at" DESC)
  WHERE "status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');

-- Open issues by project (for project board)
CREATE INDEX "idx_issues_project_status_open"
  ON "issues" ("project_id", "status", "updated_at" DESC)
  WHERE "status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');

-- ============================================
-- 7. cost_events partial indexes
-- ============================================

-- Recent cost events by company (for spend dashboard)
CREATE INDEX "idx_cost_events_company_id_created_at"
  ON "cost_events" ("company_id", "created_at" DESC);

-- ============================================
-- 8. mission_sessions partial indexes (beyond existing active partial)
-- ============================================

-- Expired sessions for cleanup
CREATE INDEX "idx_mission_sessions_expires_at_past"
  ON "mission_sessions" ("expires_at" ASC)
  WHERE "status" = 'active';

-- ===== ROLLBACK =====
-- To rollback, execute the following:
--
-- DROP INDEX IF EXISTS "idx_mission_sessions_expires_at_past";
-- DROP INDEX IF EXISTS "idx_cost_events_company_id_created_at";
-- DROP INDEX IF EXISTS "idx_issues_project_status_open";
-- DROP INDEX IF EXISTS "idx_issues_assignee_status_open";
-- DROP INDEX IF EXISTS "idx_activity_log_actor_type_actor_id_created_at";
-- DROP INDEX IF EXISTS "idx_activity_log_company_id_created_at";
-- DROP INDEX IF EXISTS "idx_srb_nonces_received_at_old";
-- DROP INDEX IF EXISTS "idx_worktree_audit_log_issue_id_created_at";
-- DROP INDEX IF EXISTS "idx_worktree_audit_log_agent_id_created_at";
-- DROP INDEX IF EXISTS "idx_heartbeat_run_events_run_id_created_at";
-- DROP INDEX IF EXISTS "idx_heartbeat_runs_status_queued_running";
