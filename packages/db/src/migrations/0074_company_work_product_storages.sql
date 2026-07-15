-- Company-scoped work-product storage profiles.
-- Additive and idempotent. Hand-authored because the drizzle-kit journal is stale past 0047.

CREATE TABLE IF NOT EXISTS "company_work_product_storages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL DEFAULT 'local_disk',
  "endpoint" text,
  "region" text,
  "bucket" text,
  "key_prefix" text,
  "force_path_style" boolean NOT NULL DEFAULT false,
  "access_key_secret_id" uuid REFERENCES "company_secrets" ("id") ON DELETE SET NULL,
  "secret_access_key_secret_id" uuid REFERENCES "company_secrets" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_work_product_storages_company_uq"
  ON "company_work_product_storages" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_work_product_storages_company_provider_idx"
  ON "company_work_product_storages" ("company_id", "provider");
