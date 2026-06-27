-- [Task 1D Step 5] event ledger idempotency: partial unique index on (company_id, idempotency_key)
-- WHERE idempotency_key IS NOT NULL. Prevents duplicate transition events for the same
-- deterministic key. Forward-only, IF NOT EXISTS guard.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_transition_events_idempotency_uq"
	ON "workflow_transition_events" ("company_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL;
