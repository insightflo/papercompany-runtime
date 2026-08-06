CREATE INDEX "heartbeat_runs_company_created_idx" ON "heartbeat_runs" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_status_created_idx" ON "heartbeat_runs" USING btree ("company_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_agent_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at","id");
