---
title: CLI Overview
summary: CLI installation and setup
---

The papercompany CLI handles instance setup, diagnostics, and control-plane operations.

## Usage

```sh
pnpm paperclipai --help
```

## Client Options

Control-plane (client) commands — issues, agents, approvals, activity, dashboard, company, plugin, auth — support these options:

| Flag | Description |
|------|-------------|
| `-C, --company-id <id>` | Company ID (required by company-scoped commands) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API authentication token |
| `--context <path>` | Context file path |
| `--profile <name>` | Context profile name |
| `--json` | Output as JSON |

Setup commands (`onboard`, `doctor`, `env`, `configure`, `run`, `db:backup`) do **not** support these options — they use `-c/--config` and `-d/--data-dir` instead.

For clean local instances, pass `--data-dir` on the command you run:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store defaults to avoid repeating flags:

```sh
# Set defaults
pnpm paperclipai context set --api-base http://localhost:3200 --company-id <id>

# View current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list

# Switch profile
pnpm paperclipai context use default

# Set a profile
pnpm paperclipai context set --profile ops --api-base http://localhost:3200

# JSON output
pnpm paperclipai context list --json
```

To avoid storing secrets in context, use an env var:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

Context is stored at `~/.paperclip/context.json`.

## Command Categories

The CLI has two categories:

1. **[Setup commands](/cli/setup-commands)** — instance bootstrap, diagnostics, configuration
2. **[Control-plane commands](/cli/control-plane-commands)** — issues, agents, approvals, activity
