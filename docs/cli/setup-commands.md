---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `paperclipai run`

One-command bootstrap and start:

```sh
pnpm paperclipai run
```

Does:

1. Auto-onboards if config is missing
2. Runs `paperclipai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm paperclipai run --instance dev
```

Repair control:

```sh
pnpm paperclipai run --repair     # run doctor with auto-repair before start
pnpm paperclipai run --no-repair  # skip repair
```

Config and data-dir flags (setup commands use `-c/--config`, `-d/--data-dir` instead of the client options):

```sh
pnpm paperclipai run -c ./config.json -d ./data
```

## `paperclipai onboard`

Interactive first-time setup:

```sh
pnpm paperclipai onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm paperclipai onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm paperclipai onboard --yes
```

Custom config and data dir:

```sh
pnpm paperclipai onboard --config ./config.json --data-dir ./data
```

## `paperclipai doctor`

Health checks with optional auto-repair:

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
pnpm paperclipai doctor --fix      # alias for --repair
pnpm paperclipai doctor -y --repair # non-interactive repair
pnpm paperclipai doctor --config ./config.json --data-dir ./data
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `paperclipai configure`

Update configuration sections:

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
pnpm paperclipai configure --section llm
pnpm paperclipai configure --section database
pnpm paperclipai configure --section logging
```

Available sections: `llm`, `database`, `logging`, `server`, `storage`, `secrets`.

## `paperclipai env`

Show resolved environment configuration:

```sh
pnpm paperclipai env
```

## `paperclipai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## `paperclipai db:backup`

Create a database backup:

```sh
pnpm paperclipai db:backup
```

Options:

| Flag | Description |
|------|-------------|
| `--dir <path>` | Backup output directory |
| `--retention-days <n>` | Retention window in days |
| `--filename-prefix <prefix>` | Backup file name prefix |
| `--json` | Output as JSON |

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```
