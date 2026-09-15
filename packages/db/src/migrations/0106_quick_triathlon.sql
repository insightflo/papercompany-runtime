CREATE TABLE "quality_action_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"root_occurrence_set_hash" text NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_action_groups_revision_positive_check" CHECK ("quality_action_groups"."revision" >= 1)
);

--> statement-breakpoint
CREATE TABLE "quality_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"parent_action_id" uuid,
	"kind" text NOT NULL,
	"occurrence_set_hash" text NOT NULL,
	"occurrence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"scope_version" integer NOT NULL,
	"target" jsonb NOT NULL,
	"target_hash" text NOT NULL,
	"effect" jsonb NOT NULL,
	"effect_hash" text NOT NULL,
	"retry_envelope" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"current_decision_id" uuid,
	"current_evaluation_id" uuid,
	"intent_key" text NOT NULL,
	"canonical_binding" jsonb,
	"first_accepted_run_id" uuid,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_actions_kind_check" CHECK ("quality_actions"."kind" in ('current_output', 'qa_addendum')),
	CONSTRAINT "quality_actions_revision_positive_check" CHECK ("quality_actions"."revision" >= 1)
);

--> statement-breakpoint
CREATE TABLE "quality_consumer_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"base_hash" text NOT NULL,
	"active_version_id" uuid,
	"previous_verified_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"adoption_evidence_ref_id" uuid,
	"withdrawal_evidence_ref_id" uuid,
	CONSTRAINT "quality_consumer_bindings_hash_check" CHECK ("quality_consumer_bindings"."base_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quality_consumer_bindings_revision_check" CHECK ("quality_consumer_bindings"."revision" >= 1)
);

--> statement-breakpoint
CREATE TABLE "quality_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"review_item_id" uuid NOT NULL,
	"producer_run_id" uuid NOT NULL,
	"submission_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"source_binding" jsonb NOT NULL,
	"evidence_ref_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_occurrences_payload_hash_check" CHECK ("quality_occurrences"."payload_hash" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
CREATE TABLE "quality_policy_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"reserved_cost_cents" integer DEFAULT 0 NOT NULL,
	"charged_cost_cents" integer DEFAULT 0 NOT NULL,
	"execution_attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quality_policy_usage_window_check" CHECK ("quality_policy_usage"."window_end" > "quality_policy_usage"."window_start"),
	CONSTRAINT "quality_policy_usage_counters_check" CHECK ("quality_policy_usage"."reserved_cost_cents" >= 0 and "quality_policy_usage"."charged_cost_cents" >= 0 and "quality_policy_usage"."execution_attempts" >= 0 and "quality_policy_usage"."revision" >= 1)
);

--> statement-breakpoint
CREATE TABLE "quality_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"enabled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_policy_versions_version_positive_check" CHECK ("quality_policy_versions"."version" >= 1),
	CONSTRAINT "quality_policy_versions_enabled_requires_approval_check" CHECK ("quality_policy_versions"."enabled_at" is null or ("quality_policy_versions"."approved_by_user_id" is not null and "quality_policy_versions"."approved_at" is not null)),
	CONSTRAINT "quality_policy_versions_disabled_after_enabled_check" CHECK ("quality_policy_versions"."disabled_at" is null or "quality_policy_versions"."enabled_at" is not null)
);

--> statement-breakpoint
CREATE UNIQUE INDEX "quality_action_groups_company_id_uq" ON "quality_action_groups" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_actions_company_id_uq" ON "quality_actions" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_actions_company_intent_uq" ON "quality_actions" USING btree ("company_id","intent_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_consumer_bindings_target_uq" ON "quality_consumer_bindings" USING btree ("company_id","template_id","base_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_occurrences_company_producer_key_uq" ON "quality_occurrences" USING btree ("company_id","producer_run_id","submission_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_policy_usage_company_policy_window_uq" ON "quality_policy_usage" USING btree ("company_id","policy_version_id","window_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_policy_versions_company_version_uq" ON "quality_policy_versions" USING btree ("company_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_policy_versions_company_id_uq" ON "quality_policy_versions" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_policy_versions_company_active_uq" ON "quality_policy_versions" USING btree ("company_id") WHERE "quality_policy_versions"."enabled_at" is not null and "quality_policy_versions"."disabled_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakeup_requests_quality_action_wake_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" like 'quality-action-wake:%';
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluator_versions_quality_company_id_uq" ON "evaluator_versions" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_quality_company_id_uq" ON "heartbeat_runs" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_plan_templates_quality_company_id_uq" ON "mission_plan_templates" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_evidence_refs_quality_company_id_uq" ON "quality_evidence_refs" USING btree ("company_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quality_review_items_quality_company_id_uq" ON "quality_review_items" USING btree ("company_id","id");
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "quality_acceptance" jsonb;
--> statement-breakpoint
ALTER TABLE "evaluator_candidate_runs" ADD COLUMN "quality_action_id" uuid;
--> statement-breakpoint
ALTER TABLE "evaluator_candidate_runs" ADD COLUMN "quality_contract" jsonb;
--> statement-breakpoint
ALTER TABLE "evaluator_versions" ADD COLUMN "quality_action_id" uuid;
--> statement-breakpoint
ALTER TABLE "evaluator_versions" ADD COLUMN "quality_contract" jsonb;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "quality_plan_qa_binding" jsonb;
--> statement-breakpoint
ALTER TABLE "mission_plan_qa_verdicts" ADD COLUMN "quality_contract" jsonb;
--> statement-breakpoint
ALTER TABLE "operator_decisions" ADD COLUMN "quality_action_id" uuid;
--> statement-breakpoint
ALTER TABLE "operator_decisions" ADD COLUMN "quality_binding" jsonb;
--> statement-breakpoint
ALTER TABLE "quality_evidence_refs" ADD COLUMN "quality_action_id" uuid;
--> statement-breakpoint
ALTER TABLE "quality_evidence_refs" ADD COLUMN "quality_contract" jsonb;
--> statement-breakpoint
ALTER TABLE "quality_action_groups" ADD CONSTRAINT "quality_action_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_action_groups" ADD CONSTRAINT "quality_action_groups_company_id_policy_version_id_quality_policy_versions_company_id_id_fk" FOREIGN KEY ("company_id","policy_version_id") REFERENCES "public"."quality_policy_versions"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_company_id_first_accepted_run_id_heartbeat_runs_company_id_id_fk" FOREIGN KEY ("company_id","first_accepted_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_company_id_group_id_quality_action_groups_company_id_id_fk" FOREIGN KEY ("company_id","group_id") REFERENCES "public"."quality_action_groups"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_company_id_policy_version_id_quality_policy_versions_company_id_id_fk" FOREIGN KEY ("company_id","policy_version_id") REFERENCES "public"."quality_policy_versions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_actions" ADD CONSTRAINT "quality_actions_company_id_parent_action_id_quality_actions_company_id_id_fk" FOREIGN KEY ("company_id","parent_action_id") REFERENCES "public"."quality_actions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_template_id_mission_plan_templates_company_id_id_fk" FOREIGN KEY ("company_id","template_id") REFERENCES "public"."mission_plan_templates"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_active_version_id_evaluator_versions_company_id_id_fk" FOREIGN KEY ("company_id","active_version_id") REFERENCES "public"."evaluator_versions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_previous_verified_version_id_evaluator_versions_company_id_id_fk" FOREIGN KEY ("company_id","previous_verified_version_id") REFERENCES "public"."evaluator_versions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_adoption_evidence_ref_id_quality_evidence_refs_company_id_id_fk" FOREIGN KEY ("company_id","adoption_evidence_ref_id") REFERENCES "public"."quality_evidence_refs"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_consumer_bindings" ADD CONSTRAINT "quality_consumer_bindings_company_id_withdrawal_evidence_ref_id_quality_evidence_refs_company_id_id_fk" FOREIGN KEY ("company_id","withdrawal_evidence_ref_id") REFERENCES "public"."quality_evidence_refs"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_occurrences" ADD CONSTRAINT "quality_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_occurrences" ADD CONSTRAINT "quality_occurrences_company_id_review_item_id_quality_review_items_company_id_id_fk" FOREIGN KEY ("company_id","review_item_id") REFERENCES "public"."quality_review_items"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_occurrences" ADD CONSTRAINT "quality_occurrences_company_id_producer_run_id_heartbeat_runs_company_id_id_fk" FOREIGN KEY ("company_id","producer_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_policy_usage" ADD CONSTRAINT "quality_policy_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_policy_usage" ADD CONSTRAINT "quality_policy_usage_company_id_policy_version_id_quality_policy_versions_company_id_id_fk" FOREIGN KEY ("company_id","policy_version_id") REFERENCES "public"."quality_policy_versions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_policy_versions" ADD CONSTRAINT "quality_policy_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "quality_action_groups_company_policy_idx" ON "quality_action_groups" USING btree ("company_id","policy_version_id");
--> statement-breakpoint
CREATE INDEX "quality_actions_company_group_idx" ON "quality_actions" USING btree ("company_id","group_id");
--> statement-breakpoint
CREATE INDEX "quality_actions_company_state_idx" ON "quality_actions" USING btree ("company_id","state","created_at");
--> statement-breakpoint
CREATE INDEX "quality_occurrences_company_received_idx" ON "quality_occurrences" USING btree ("company_id","received_at");
--> statement-breakpoint
CREATE INDEX "quality_occurrences_review_item_idx" ON "quality_occurrences" USING btree ("review_item_id");
--> statement-breakpoint
CREATE INDEX "quality_policy_versions_company_enabled_idx" ON "quality_policy_versions" USING btree ("company_id","enabled_at");
--> statement-breakpoint
ALTER TABLE "evaluator_candidate_runs" ADD CONSTRAINT "evaluator_candidate_runs_company_id_quality_action_id_quality_actions_company_id_id_fk" FOREIGN KEY ("company_id","quality_action_id") REFERENCES "public"."quality_actions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluator_versions" ADD CONSTRAINT "evaluator_versions_company_id_quality_action_id_quality_actions_company_id_id_fk" FOREIGN KEY ("company_id","quality_action_id") REFERENCES "public"."quality_actions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_decisions" ADD CONSTRAINT "operator_decisions_company_id_quality_action_id_quality_actions_company_id_id_fk" FOREIGN KEY ("company_id","quality_action_id") REFERENCES "public"."quality_actions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_evidence_refs" ADD CONSTRAINT "quality_evidence_refs_company_id_quality_action_id_quality_actions_company_id_id_fk" FOREIGN KEY ("company_id","quality_action_id") REFERENCES "public"."quality_actions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_decisions" ADD CONSTRAINT "operator_decisions_quality_continuation_check" CHECK ("operator_decisions"."quality_action_id" is null or "operator_decisions"."continuation_mode" = 'none');
