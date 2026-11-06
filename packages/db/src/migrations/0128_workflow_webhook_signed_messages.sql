CREATE UNIQUE INDEX "workflow_webhook_deliveries_scope_id_uq" ON "workflow_webhook_deliveries" USING btree ("company_id", "workflow_id", "id");
--> statement-breakpoint
CREATE TABLE "workflow_webhook_signed_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "workflow_id" uuid NOT NULL,
  "delivery_id" uuid NOT NULL,
  "message_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_webhook_signed_messages_delivery_scope_fk" FOREIGN KEY ("company_id", "workflow_id", "delivery_id") REFERENCES "public"."workflow_webhook_deliveries"("company_id", "workflow_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_webhook_signed_messages_hash_uq" ON "workflow_webhook_signed_messages" USING btree ("company_id", "workflow_id", "message_hash");
--> statement-breakpoint
CREATE INDEX "idx_workflow_webhook_signed_messages_delivery_id" ON "workflow_webhook_signed_messages" USING btree ("delivery_id");
