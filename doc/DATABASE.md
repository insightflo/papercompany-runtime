# Database

papercompany uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

Compatibility note: local paths, CLI package names, and environment variables still use Paperclip-era names such as `~/.paperclip`, `paperclipai`, and `PAPERCLIP_*`. They are retained so existing instances and tooling continue to work while the product documentation moves to papercompany.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active papercompany config/instance.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Run migrations (once the migration generation issue is fixed) or use `drizzle-kit push`:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

Set `DATABASE_URL` in your `.env`:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

If using connection pooling (port 6543), the `postgres` client must disable prepared statements. Update `packages/db/src/client.ts`:

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  npx drizzle-kit push
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Secret storage

papercompany stores secret metadata and versions in:

- `company_secrets`
- `company_secret_versions`

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
pnpm secrets:migrate-inline-env --apply
```
## Workflow step-status provenance (observability)

`workflow_transition_events` rows with `event_type='workflow_step_status_transition'`, `layer='workflow_sync'`, and `reason_code=<caller source>` are appended whenever a `workflow_step_runs.status` physically changes to a terminal value (`completed`/`failed`/`skipped`). The recorder is savepoint-isolated so an observability insert failure can never roll back the authoritative transaction. Idempotency key: `wf-step-status:<stepRunId>:<toStatus>:<statusTransitionVersion>` (the trigger-maintained `workflow_step_runs.status_transition_version` monotonic column dedupes concurrent/different-source observers to exactly one row per physical transition). The originating caller source is threaded into the first mutation/sync (e.g. `issues_service`, `plugin_host`, `heartbeat_promotion`, `workflow_retry`). See `doc/runbooks/workflow-step-status-provenance.md` for the attribution query. These rows are audit/observability only and are never execution authority.

## Heartbeat finalization v1 (lifecycle completion) — feature-flagged, shadow

`heartbeat_runs.settled_at` is the durable heartbeat lifecycle-completion signal, distinct from the result/display `status`. It is written only after a run's non-compensable quiescence/runtime-release stages are positively observed and mandatory business side-effects are done or equivalently failed. The v1 writers are gated by the experimental instance setting `enableHeartbeatFinalizationV1` (default OFF); with the flag off, legacy behavior is unchanged and `settled_at` is never written by v1 code.

Relevant `heartbeat_runs` columns: `execution_epoch`, `execution_token`, `executor_owner_*` (lease/ack/release), `terminal_outcome`/`terminal_decided_at`/`terminal_decision_source` (first-wins), `finalization_version` (0=legacy, 1=v1), `settled_at`, `execution_scope_kind`, `workflow_step_run_id`/`workflow_execution_generation` (typed workflow link). Generation is also persisted on `agent_wakeup_requests` and `workflow_step_runs` (`execution_generation`) so a stale queued wake cannot bind a newer generation; `workflow_delegations.source_execution_generation` scopes delegation callbacks.

New tables: `heartbeat_run_finalizations` (finalization parent: immutable outcome, finalizer lease/fence), `heartbeat_run_finalization_steps` (Q/C/O stage records, unique `(company_id, heartbeat_run_id, stage_kind, idempotency_key)`), `workflow_resync_jobs`, `agent_queue_admission_jobs` (durable post-settlement work with `pending|leased|completed|dead_letter` lifecycle, lease/fence, `SKIP LOCKED` claiming).

Stage classes: **Q** (non-compensable — exact revoked-owner quiescence, process/provider absence, run-owned `workspace_operations` non-running, `workspace_runtime_services` stopped, bound `mission_agent_runtimes` not busy; positive observation only; a dead-lettered Q stage permanently blocks settlement as `blocked_noncompensable`), **C** (compensable business side-effects; may be satisfied by an equivalent structured failure), **O** (optional; may dead-letter). Enforcement (successor dispatch and workflow finalization gated on evidence-ready AND owner-settled) lands in a later phase; until then these columns are written in shadow and unread.
