CREATE INDEX IF NOT EXISTS "idx_srb_delivery_log_status_updated_at"
  ON "srb_delivery_log" ("status", "updated_at");
