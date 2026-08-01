-- Workflow and heartbeat authority/finalization Phase A: additive lookup and claim indexes.
-- Partial claim indexes cover only future durable-job states and do not validate legacy rows.

CREATE INDEX IF NOT EXISTS "workflow_step_runs_dispatch_owner_wakeup_request_id_idx"
  ON "workflow_step_runs" ("dispatch_owner_wakeup_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_step_runs_dispatch_owner_heartbeat_run_id_idx"
  ON "workflow_step_runs" ("dispatch_owner_heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_workflow_step_generation_idx"
  ON "agent_wakeup_requests" ("workflow_step_run_id", "workflow_execution_generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_workflow_step_generation_idx"
  ON "heartbeat_runs" ("company_id", "workflow_step_run_id", "workflow_execution_generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_unsettled_finalization_idx"
  ON "heartbeat_runs" ("company_id", "finalization_version")
  WHERE "finalization_version" > 0 AND "settled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_delegations_source_generation_status_idx"
  ON "workflow_delegations" (
    "source_workflow_run_id",
    "source_workflow_step_run_id",
    "source_execution_generation",
    "status"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_work_products_created_by_run_generation_idx"
  ON "issue_work_products" ("created_by_run_id", "source_execution_generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_step_generation_idx"
  ON "workflow_transition_events" ("workflow_step_run_id", "execution_generation", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_finalizations_heartbeat_run_id_idx"
  ON "heartbeat_run_finalizations" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_finalizations_claim_idx"
  ON "heartbeat_run_finalizations" ("company_id", "state", "finalizer_lease_expires_at")
  WHERE "state" IN ('pending', 'leased');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_finalization_steps_heartbeat_run_id_idx"
  ON "heartbeat_run_finalization_steps" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_finalization_steps_finalization_id_idx"
  ON "heartbeat_run_finalization_steps" ("heartbeat_run_finalization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_finalization_steps_claim_idx"
  ON "heartbeat_run_finalization_steps" ("company_id", "state", "lease_expires_at")
  WHERE "state" IN ('pending', 'leased');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_finalization_steps_stage_idempotency_uq"
  ON "heartbeat_run_finalization_steps" ("company_id", "heartbeat_run_id", "stage_kind", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_resync_jobs_workflow_run_id_idx"
  ON "workflow_resync_jobs" ("workflow_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_resync_jobs_workflow_step_run_id_idx"
  ON "workflow_resync_jobs" ("workflow_step_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_resync_jobs_claim_idx"
  ON "workflow_resync_jobs" ("state", "next_attempt_at", "lease_expires_at")
  WHERE "state" IN ('pending', 'leased');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_resync_jobs_dedupe_key_uq"
  ON "workflow_resync_jobs" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_queue_admission_jobs_agent_id_idx"
  ON "agent_queue_admission_jobs" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_queue_admission_jobs_heartbeat_run_id_idx"
  ON "agent_queue_admission_jobs" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_queue_admission_jobs_claim_idx"
  ON "agent_queue_admission_jobs" ("state", "next_attempt_at", "lease_expires_at")
  WHERE "state" IN ('pending', 'leased');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_queue_admission_jobs_dedupe_key_uq"
  ON "agent_queue_admission_jobs" ("dedupe_key");
