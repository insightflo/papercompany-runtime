ALTER TABLE "workflow_recovery_authorities" ADD COLUMN "owner_decision_event_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD COLUMN "operator_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD COLUMN "replacement_run_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD COLUMN "replacement_contract" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_owner_decision_event_id_workflow_transition_events_id_fk" FOREIGN KEY ("owner_decision_event_id") REFERENCES "public"."workflow_transition_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_operator_approval_id_approvals_id_fk" FOREIGN KEY ("operator_approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_authorities_replacement_run_id_workflow_runs_id_fk" FOREIGN KEY ("replacement_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_replacement_target_uq" ON "workflow_recovery_authorities" USING btree ("replacement_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_recovery_replacement_approval_uq" ON "workflow_recovery_authorities" USING btree ("operator_approval_id");--> statement-breakpoint
ALTER TABLE "workflow_recovery_authorities" ADD CONSTRAINT "workflow_recovery_replacement_required" CHECK ("workflow_recovery_authorities"."recovery_kind" <> 'replacement_from_start_v1' or (
      "workflow_recovery_authorities"."owner_decision_event_id" is not null and "workflow_recovery_authorities"."operator_approval_id" is not null and "workflow_recovery_authorities"."replacement_run_id" is not null
      and "workflow_recovery_authorities"."request_hash" is not null and "workflow_recovery_authorities"."request_reference" is not null and "workflow_recovery_authorities"."replacement_contract" is not null
      and "workflow_recovery_authorities"."status" = 'consumed' and "workflow_recovery_authorities"."resulting_authority_version" = "workflow_recovery_authorities"."target_authority_version"));