ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "requested_by_plugin_id" text;
