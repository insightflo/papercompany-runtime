-- structured-events p1: structured submission tables + event ledger + typed queue columns
-- Forward-only DDL. Does NOT alter existing projection tables (current-state SoT).

-- Task 1: structured submission tables
CREATE TABLE IF NOT EXISTS "mission_plan_decision_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"planning_issue_id" uuid,
	"author_agent_id" uuid,
	"author_user_id" text,
	"source_run_id" uuid,
	"source_comment_id" uuid,
	"decision_hash" text NOT NULL,
	"decision" jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_plan_decision_submissions_mission_hash_idx"
	ON "mission_plan_decision_submissions" ("company_id", "mission_id", "decision_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_plan_decision_submissions_mission_created_idx"
	ON "mission_plan_decision_submissions" ("company_id", "mission_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mission_plan_qa_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_plan_artifact_id" uuid,
	"plan_qa_issue_id" uuid NOT NULL,
	"reviewer_agent_id" uuid,
	"reviewer_user_id" text,
	"source_run_id" uuid,
	"source_comment_id" uuid,
	"decision_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_plan_qa_verdicts_issue_hash_idx"
	ON "mission_plan_qa_verdicts" ("company_id", "plan_qa_issue_id", "decision_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_plan_qa_verdicts_mission_created_idx"
	ON "mission_plan_qa_verdicts" ("company_id", "mission_id", "created_at");
--> statement-breakpoint

-- Task 1B: workflow transition event ledger (append-only, NOT state SoT)
CREATE TABLE IF NOT EXISTS "workflow_transition_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid,
	"workflow_run_id" uuid,
	"workflow_step_run_id" uuid,
	"issue_id" uuid,
	"wakeup_request_id" uuid,
	"heartbeat_run_id" uuid,
	"event_type" text NOT NULL,
	"layer" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"decision" text,
	"verdict" text,
	"reason" text,
	"reason_code" text,
	"correlation_id" text,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_workflow_run_event_idx"
	ON "workflow_transition_events" ("company_id", "workflow_run_id", "event_type", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_mission_event_idx"
	ON "workflow_transition_events" ("company_id", "mission_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_wakeup_event_idx"
	ON "workflow_transition_events" ("wakeup_request_id", "event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_heartbeat_run_event_idx"
	ON "workflow_transition_events" ("heartbeat_run_id", "event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transition_events_correlation_idx"
	ON "workflow_transition_events" ("company_id", "correlation_id", "created_at");
--> statement-breakpoint

-- Task 1C: typed queue columns on agent_wakeup_requests
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "request_kind" text;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "workflow_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "workflow_step_run_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_request_kind_idx"
	ON "agent_wakeup_requests" ("company_id", "request_kind", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_issue_status_idx"
	ON "agent_wakeup_requests" ("issue_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_mission_status_idx"
	ON "agent_wakeup_requests" ("company_id", "mission_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_workflow_step_status_idx"
	ON "agent_wakeup_requests" ("workflow_step_run_id", "status");
