ALTER TABLE "srb_delivery_log"
  ADD COLUMN "payload_json" jsonb,
  ADD COLUMN "idempotency_key" text,
  ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

UPDATE "srb_delivery_log"
SET "updated_at" = COALESCE("last_attempt_at", "created_at")
WHERE "updated_at" IS NULL;
