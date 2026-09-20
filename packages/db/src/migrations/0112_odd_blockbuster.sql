CREATE TABLE "workflow_step_output_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"consumer_step_run_id" uuid NOT NULL,
	"referenced_step_id" text NOT NULL,
	"work_product_id" uuid NOT NULL,
	"source_execution_generation" integer,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_step_output_bindings" ADD CONSTRAINT "workflow_step_output_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_output_bindings" ADD CONSTRAINT "workflow_step_output_bindings_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_output_bindings" ADD CONSTRAINT "workflow_step_output_bindings_consumer_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("consumer_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_output_bindings" ADD CONSTRAINT "workflow_step_output_bindings_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_output_bindings_step_reference_uq" ON "workflow_step_output_bindings" USING btree ("company_id","workflow_run_id","consumer_step_run_id","referenced_step_id");--> statement-breakpoint
CREATE INDEX "workflow_step_output_bindings_work_product_idx" ON "workflow_step_output_bindings" USING btree ("work_product_id");--> statement-breakpoint
CREATE INDEX "workflow_step_output_bindings_workflow_run_idx" ON "workflow_step_output_bindings" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "workflow_step_output_bindings_consumer_step_run_idx" ON "workflow_step_output_bindings" USING btree ("consumer_step_run_id");--> statement-breakpoint
UPDATE "issue_work_products" SET "is_primary" = false WHERE "is_primary" = true AND "id" NOT IN (
	SELECT DISTINCT ON ("company_id", "issue_id", "type") "id"
	FROM "issue_work_products"
	WHERE "is_primary" = true
	ORDER BY "company_id", "issue_id", "type", "updated_at" DESC, "id" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "issue_work_products_primary_uq" ON "issue_work_products" USING btree ("company_id","issue_id","type") WHERE is_primary = true;
