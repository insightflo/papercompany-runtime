CREATE TABLE "effect_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"effect_kind" text NOT NULL,
	"effect_id" text NOT NULL,
	"anchor_key" text NOT NULL,
	"generation_key" text NOT NULL,
	"params_hash" text NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"attempt_run_id" text,
	"result_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "effect_intents" ADD CONSTRAINT "effect_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "effect_intents_effect_id_key" ON "effect_intents" USING btree ("effect_id");--> statement-breakpoint
CREATE INDEX "effect_intents_company_kind_anchor_idx" ON "effect_intents" USING btree ("company_id","effect_kind","anchor_key");--> statement-breakpoint
CREATE INDEX "effect_intents_status_idx" ON "effect_intents" USING btree ("status");