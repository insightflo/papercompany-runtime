# Agent API-key responsibility upgrade

Operator runbook for migration `0087_agent_api_keys_responsibility_scope`: backfilling or revoking agent API keys that lack a responsible user, and reissuing keys the migration cannot resolve.

This runbook is operator documentation only; it is never read by runtime control flow. All behavior described here is implemented in `packages/db/src/migrations/0087_agent_api_keys_responsibility_scope.sql`, `packages/db/src/agent-api-key-responsibility-report.ts`, and `server/src/services/agent-api-key-policy.ts`.

## 1. Purpose and interruption risk

Every active agent API key must have a responsible user (`responsible_user_id`): an actual user with an active same-company membership, or the exact `instance_admin` role. Migration 0087 reconciles existing keys:

- `backfill` — exactly one eligible candidate exists; the key is bound to that user.
- `revoke` — no provenance, no eligible candidate, or conflicting candidates; the key is revoked.
- `preserve_revoked` — already revoked; left untouched.

The migration is a single database transaction guarded by advisory lock `870087001`. If it fails, nothing is committed. If it succeeds, report and revocation are committed together.

**Automatic migration commits report and revocation together; it does not provide a human pre-ack window.**

Plan for operator time before running: preview first (section 3), identify keys with `requiresOperatorAction: true`, and schedule reissue (section 7).

## 2. Backup and restoration boundary

Run a one-off backup to an operator-owned directory and verify the returned file is non-empty:

```sh
BACKUP_DIR="${BACKUP_DIR:?set an operator-owned backup directory}"
pnpm paperclipai db:backup --dir "$BACKUP_DIR" --json > /tmp/paperclip-0087-backup.json
BACKUP_FILE=$(node -e 'const fs=require("fs");const t=fs.readFileSync("/tmp/paperclip-0087-backup.json","utf8");const m=t.match(/\{[\s\S]*\}/);if(!m)process.exit(1);process.stdout.write(JSON.parse(m[0]).backupFile)')
test -s "$BACKUP_FILE"
```

This repository has no automatic restore command. If restoration is required, stop the upgrade and use the approved PostgreSQL restore procedure for the deployment after confirming target/overwrite direction; do not improvise a restore from this runbook.

## 3. Optional read-only preview, saved for later comparison

```sh
pnpm --filter @paperclipai/db report:agent-api-key-responsibility -- --mode preview \
  > /tmp/agent-api-key-responsibility-preview.json
```

The preview runs inside a read-only transaction and mutates nothing. Keep this file; the stored receipt in section 5 should agree with it for every key.

## 4. Apply checked-in migrations

```sh
pnpm db:migrate
```

**`drizzle-kit push` is insufficient because it does not execute 0087 data reconciliation/report/revocation.**

`pnpm db:migrate` applies checked-in migrations in order, each as one transaction. For 0087 that transaction performs, for every key: deterministic provenance from `direct_key_created` / `join_claim`, exact-one backfill, report-before-mutation (`agent_api_key.responsibility_migration_reported`), revocation of unresolved keys, and the final invariant check.

## 5. Read committed receipt

```sh
pnpm --filter @paperclipai/db report:agent-api-key-responsibility -- --mode stored \
  > /tmp/agent-api-key-responsibility-stored.json
```

`--mode stored` reads the receipts the migration committed to `activity_log` (action `agent_api_key.responsibility_migration_reported`, actor type `system`, actor id `migration:0087_agent_api_keys_responsibility_scope`) and validates every receipt against the exact schema (schemaVersion 1). If no exact receipt exists, the command fails — do not continue; the migration did not commit.

## 6. Verify invariant

```sql
SELECT count(*) AS invalid_active_key_count
FROM agent_api_keys
WHERE revoked_at IS NULL
  AND responsible_user_id IS NULL;
```

Expected result: `0`.

Any non-zero result means the migration's own invariant check was bypassed or the database was modified afterwards; stop and restore before proceeding.

## 7. Reissue unresolved keys

Reissue keys listed with `requiresOperatorAction: true` through the supported board key-creation API/UI; old plaintext cannot be recovered.

## 8. Verify a reissued key over HTTP without echoing it

```sh
: "${PAPERCLIP_API_URL:?set API origin, for example http://localhost:3200}"
: "${PAPERCLIP_API_KEY:?set the reissued key without echoing it}"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/me" >/tmp/paperclip-agent-me.json
```

Verify WebSocket on `/api/companies/$PAPERCLIP_COMPANY_ID/events/ws` with the bearer header using a client that does not log headers; success means the upgrade returns HTTP 101 and the connection opens. Do not put the token in the query string, shell tracing, command history, or report. If no approved header-capable WebSocket client is installed, record WebSocket verification as not run rather than installing one or exposing the token.

## 9. Secret exclusion checklist

Confirm none of the following ever appear in outputs, logs, or reports produced by this upgrade:

- key hashes or plaintext keys (including the value of `$PAPERCLIP_API_KEY`)
- join-request claim secrets
- auth tokens in query strings, shell tracing, command history, or reports
- backup contents beyond the backup file path

The migration report, stored receipts, and this runbook's verification steps are designed to exclude all of the above.

## 10. Failure/rollback interpretation

- If `pnpm db:migrate` fails, 0087 rolled back as one transaction: no responsibility columns changed, no receipts, no revocations. Fix the cause and re-run; replay is idempotent.
- If `--mode stored` fails, the migration did not commit a valid receipt; do not assume success.
- If the invariant query returns a non-zero count, stop: some active key has no responsibility. Restore per section 2 after confirming target/overwrite direction; do not improvise.
- After a successful upgrade, re-running 0087 is a no-op: existing receipts are reused, already-revoked keys stay `preserve_revoked`, and revoked keys are never revoked twice.
