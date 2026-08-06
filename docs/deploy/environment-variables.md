---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that papercompany uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | Server port (the Docker image pins `3100` — see the Docker section) |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Deployment exposure: `private` or `public` |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | — | Comma-separated hostnames allowed in authenticated/private mode |
| `PAPERCLIP_LISTEN_HOST` | `127.0.0.1` | Explicit listen host override |
| `PAPERCLIP_LISTEN_PORT` | `3200` | Explicit listen port override (alias for `PORT`) |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `false` | Allow deleting companies via the API |
| `SERVE_UI` | `true` | Serve the web UI from the server |
| `PAPERCLIP_OPEN_ON_LISTEN` | `true` | Open the browser when the server starts |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | `false` | Use Vite dev middleware for the UI |
| `PAPERCLIP_LOG_DIR` | `~/.paperclip/.../logs` | Log output directory |
| `PAPERCLIP_CONFIG` | `~/.paperclip/.../config.json` | Config file path |
| `PAPERCLIP_CONTEXT` | `~/.paperclip/context.json` | CLI context file path |

## Authentication & JWT

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_AGENT_JWT_SECRET` | (auto-generated) | Secret for agent run JWTs |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | `3600` | Agent JWT time-to-live |
| `PAPERCLIP_AGENT_JWT_ISSUER` | — | Agent JWT issuer claim |
| `PAPERCLIP_AGENT_JWT_AUDIENCE` | — | Agent JWT audience claim |
| `BETTER_AUTH_SECRET` | (auto-generated) | Better Auth session secret |
| `BETTER_AUTH_URL` | — | Better Auth base URL |
| `BETTER_AUTH_BASE_URL` | — | Alias for `BETTER_AUTH_URL` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | — | Comma-separated trusted origins for auth |
| `PAPERCLIP_PUBLIC_URL` | — | Public URL of the instance (used in auth links) |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | — | Public auth base URL |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `auto` | Auth base URL resolution mode |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `false` | Disable public sign-up |
| `PAPERCLIP_AUTH_GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `PAPERCLIP_AUTH_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `PAPERCLIP_AUTH_KAKAO_CLIENT_ID` | — | Kakao OAuth client ID |
| `PAPERCLIP_AUTH_KAKAO_CLIENT_SECRET` | — | Kakao OAuth client secret |
| `PAPERCLIP_AUTH_NAVER_CLIENT_ID` | — | Naver OAuth client ID |
| `PAPERCLIP_AUTH_NAVER_CLIENT_SECRET` | — | Naver OAuth client secret |

## Database

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_MIGRATION_PROMPT` | `true` | Prompt before applying migrations |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `false` | Auto-apply migrations without prompting |
| `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE` | `false` | Verbose embedded PostgreSQL logging |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |
| `PAPERCLIP_SECRETS_PROVIDER` | `local_encrypted` | Secrets provider: `local_encrypted` or external vault |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_STORAGE_PROVIDER` | `local_disk` | Storage provider: `local_disk` or `s3` |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | `~/.paperclip/.../storage` | Local storage directory |
| `PAPERCLIP_STORAGE_S3_BUCKET` | — | S3 bucket name |
| `PAPERCLIP_STORAGE_S3_REGION` | — | S3 region |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | — | S3-compatible endpoint URL |
| `PAPERCLIP_STORAGE_S3_PREFIX` | — | Key prefix inside the bucket |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `false` | Force path-style S3 addressing |

## Database Backups

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_DB_BACKUP_ENABLED` | `true` | Enable scheduled DB backups |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `1440` | Backup interval (24 hours) |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `3` | Backup retention window |
| `PAPERCLIP_DB_BACKUP_DIR` | — | Backup output directory |

## Heartbeat Scheduler

| Variable | Default | Description |
|----------|---------|-------------|
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | Enable the heartbeat scheduler |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | — | Scheduler tick interval |

## Attachments

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` | — | Comma-separated allowed MIME types |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | — | Maximum attachment size in bytes |

## Adapters

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_CODEX_COMMAND` | `codex` | Codex CLI command override |
| `PAPERCLIP_CLAUDE_COMMAND` | `claude` | Claude Code CLI command override |
| `PAPERCLIP_GEMINI_COMMAND` | `gemini` | Gemini CLI command override |
| `HERMES_HOME` | — | Hermes adapter home directory |
| `CLAUDE_HOME` | — | Claude Code home directory |
| `CLAUDE_CONFIG_DIR` | — | Claude Code config directory |
| `CODEX_HOME` | — | Codex home directory |

## Logging & Run Records

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_LOG_BASE_PATH` | — | Base path for heartbeat run logs |
| `WORKSPACE_OPERATION_LOG_BASE_PATH` | — | Base path for workspace operation logs |

## Worktrees

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_WORKTREES_DIR` | — | Base directory for worktrees |
| `PAPERCLIP_WORKTREE_START_POINT` | — | Default worktree start point |
| `PAPERCLIP_WORKTREE_NAME` | — | Worktree name override |
| `PAPERCLIP_IN_WORKTREE` | — | Set when running inside a paperclip worktree |

## CLI Client

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SERVER_HOST` | — | Server host for CLI client commands |
| `PAPERCLIP_SERVER_PORT` | — | Server port for CLI client commands |
| `PAPERCLIP_AUTH_STORE` | — | CLI auth session storage path |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (runtime origin, no `/api`) |
| `PAPERCLIP_API_BASE_URL` | API base URL including `/api` (used for plugin tool calls) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |

## Cloudflare (mission planning)

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token used in mission owner planning context |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `MANUAL_ONBOARDING_SITE_ROOT` | Root URL for the manual onboarding site |
