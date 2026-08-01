-- Workflow and heartbeat authority/finalization Phase A: additive columns only.
-- Legacy rows retain version 0/default authority; no backfill or writer enablement occurs here.

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "dispatch_authority_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "dispatch_authority_kind" text NOT NULL DEFAULT 'legacy';
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "execution_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "dispatch_owner_wakeup_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "dispatch_owner_heartbeat_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "evidence_ready_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "workflow_step_runs"
  ADD COLUMN IF NOT EXISTS "dispatch_ready_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests"
  ADD COLUMN IF NOT EXISTS "workflow_step_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests"
  ADD COLUMN IF NOT EXISTS "workflow_execution_generation" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "workflow_step_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "workflow_execution_generation" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "execution_scope_kind" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "execution_epoch" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "execution_token" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_id" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_lease_epoch" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_lease_token" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_lease_expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_acknowledged_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "executor_owner_released_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "terminal_outcome" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "terminal_decided_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "terminal_decision_source" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "finalization_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "settled_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "workflow_delegations"
  ADD COLUMN IF NOT EXISTS "source_execution_generation" integer;
--> statement-breakpoint
ALTER TABLE "issue_work_products"
  ADD COLUMN IF NOT EXISTS "source_execution_generation" integer;
--> statement-breakpoint
ALTER TABLE "workflow_transition_events"
  ADD COLUMN IF NOT EXISTS "execution_generation" integer;
--> statement-breakpoint
ALTER TABLE "workflow_transition_events"
  ADD COLUMN IF NOT EXISTS "dispatch_owner_heartbeat_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_transition_events"
  ADD COLUMN IF NOT EXISTS "executor_owner_id" text;
--> statement-breakpoint
ALTER TABLE "workflow_transition_events"
  ADD COLUMN IF NOT EXISTS "finalization_version" integer;
