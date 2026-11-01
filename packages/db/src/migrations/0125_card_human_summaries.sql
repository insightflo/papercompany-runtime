CREATE TABLE "card_human_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"card_kind" text NOT NULL,
	"card_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"adapter_type" text DEFAULT 'pi_local' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"summary_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "card_human_summaries_kind_card_idx" ON "card_human_summaries" USING btree ("company_id","card_kind","card_id");
