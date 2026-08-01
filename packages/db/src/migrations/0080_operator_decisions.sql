CREATE TABLE "operator_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "request_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" text DEFAULT 'medium' NOT NULL,
  "interaction_type" text NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "requested_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "requested_by_user_id" text,
  "definition" jsonb NOT NULL,
  "result" jsonb,
  "resolved_by_user_id" text,
  "resolved_at" timestamptz,
  "cancelled_at" timestamptz,
  "continuation_mode" text DEFAULT 'none' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "operator_decisions_schema_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "operator_decisions_status_check" CHECK ("status" IN ('pending', 'resolved', 'cancelled')),
  CONSTRAINT "operator_decisions_priority_check" CHECK ("priority" IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT "operator_decisions_interaction_check" CHECK ("interaction_type" IN ('single_select', 'multi_select', 'action')),
  CONSTRAINT "operator_decisions_continuation_mode_check" CHECK ("continuation_mode" IN ('none', 'issue_current_assignee')),
  CONSTRAINT "operator_decisions_resolved_state_check" CHECK (
    "status" <> 'resolved' OR ("result" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL AND "resolved_at" IS NOT NULL)
  ),
  CONSTRAINT "operator_decisions_cancelled_state_check" CHECK (
    "status" <> 'cancelled' OR "cancelled_at" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "operator_decisions_company_request_uq"
  ON "operator_decisions" ("company_id", "request_key");
CREATE INDEX "operator_decisions_company_status_priority_created_idx"
  ON "operator_decisions" ("company_id", "status", "priority", "created_at");
CREATE INDEX "operator_decisions_issue_created_idx"
  ON "operator_decisions" ("issue_id", "created_at") WHERE "issue_id" IS NOT NULL;

CREATE TABLE "operator_decision_continuations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "operator_decision_id" uuid NOT NULL REFERENCES "operator_decisions"("id") ON DELETE CASCADE,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "manual_retry_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "target_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "wakeup_request_id" uuid REFERENCES "agent_wakeup_requests"("id") ON DELETE RESTRICT,
  "idempotency_key" text,
  "error_code" text,
  "error_summary" text,
  "accepted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "operator_decision_continuations_state_check" CHECK (
    "state" IN ('pending', 'leased', 'accepted', 'blocked', 'exhausted')
  ),
  CONSTRAINT "operator_decision_continuations_generation_check" CHECK (
    "generation" BETWEEN 1 AND 3 AND "manual_retry_count" BETWEEN 0 AND 2
      AND "generation" = "manual_retry_count" + 1
  ),
  CONSTRAINT "operator_decision_continuations_attempt_check" CHECK (
    "attempt_count" BETWEEN 0 AND 3 AND "max_attempts" = 3
  ),
  CONSTRAINT "operator_decision_continuations_lease_check" CHECK (
    ("state" = 'leased' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
      OR ("state" <> 'leased' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
  ),
  CONSTRAINT "operator_decision_continuations_accepted_check" CHECK (
    "state" <> 'accepted'
      OR ("wakeup_request_id" IS NOT NULL AND "idempotency_key" IS NOT NULL AND "accepted_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "operator_decision_continuations_decision_uq"
  ON "operator_decision_continuations" ("operator_decision_id");
CREATE INDEX "operator_decision_continuations_claim_idx"
  ON "operator_decision_continuations" ("state", "next_attempt_at", "lease_expires_at");
CREATE INDEX "operator_decision_continuations_company_state_updated_idx"
  ON "operator_decision_continuations" ("company_id", "state", "updated_at");
CREATE UNIQUE INDEX "operator_decision_continuations_company_key_uq"
  ON "operator_decision_continuations" ("company_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX "agent_wakeup_requests_operator_decision_idempotency_uq"
  ON "agent_wakeup_requests" ("company_id", "idempotency_key")
  WHERE "idempotency_key" LIKE 'operator-decision-wake:%';
