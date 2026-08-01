-- Workflow and heartbeat authority/finalization Phase A: new durable tables only.
-- These tables are unused until later writer phases; no legacy rows are synthesized.

CREATE TABLE IF NOT EXISTS "heartbeat_run_finalizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "heartbeat_run_id" uuid NOT NULL REFERENCES "heartbeat_runs" ("id"),
  "execution_epoch" integer NOT NULL,
  "execution_token" uuid NOT NULL,
  "terminal_outcome" text NOT NULL,
  "terminal_decision_source" text NOT NULL,
  "finalization_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "finalizer_lease_epoch" integer NOT NULL DEFAULT 0,
  "finalizer_lease_token" uuid,
  "finalizer_owner" text,
  "finalizer_lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "heartbeat_run_finalization_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "heartbeat_run_id" uuid NOT NULL REFERENCES "heartbeat_runs" ("id"),
  "heartbeat_run_finalization_id" uuid NOT NULL REFERENCES "heartbeat_run_finalizations" ("id"),
  "stage_class" text NOT NULL,
  "stage_kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "lease_epoch" integer NOT NULL DEFAULT 0,
  "lease_token" uuid,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_resync_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs" ("id"),
  "workflow_step_run_id" uuid REFERENCES "workflow_step_runs" ("id"),
  "execution_generation" integer NOT NULL,
  "dedupe_key" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "lease_epoch" integer NOT NULL DEFAULT 0,
  "lease_token" uuid,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_queue_admission_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents" ("id"),
  "heartbeat_run_id" uuid REFERENCES "heartbeat_runs" ("id"),
  "dedupe_key" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "lease_epoch" integer NOT NULL DEFAULT 0,
  "lease_token" uuid,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
