---
title: Advanced Commands
summary: Plugin, worktree, and context commands
---

Advanced CLI commands for plugin management, worktrees, and context profiles.

## Plugin Commands

Manage plugins installed on the control plane:

```sh
# List installed plugins
pnpm paperclipai plugin list

# Install a plugin
pnpm paperclipai plugin install <source> [--version <v>]

# Uninstall a plugin
pnpm paperclipai plugin uninstall <plugin-id>

# Enable / disable
pnpm paperclipai plugin enable <plugin-id>
pnpm paperclipai plugin disable <plugin-id>

# Inspect a plugin
pnpm paperclipai plugin inspect <plugin-id>

# List example plugins
pnpm paperclipai plugin examples
```

## Worktree Commands

Manage worktree-local Paperclip instances for isolated agent execution:

```sh
# Initialize worktree configuration in the current repo
pnpm paperclipai worktree init [--name <name>] [--instance <id>] [--home <path>] \
  [--from-config <path>] [--from-data-dir <path>] [--from-instance <id>] \
  [--server-port <port>] [--db-port <port>] [--seed-mode minimal|full] \
  [--no-seed] [--force]

# Create a new worktree instance (top-level command, shares options with init)
pnpm paperclipai worktree:make <name> [--start-point <ref>] [--instance <id>] [--home <path>] \
  [--from-config <path>] [--from-data-dir <path>] [--from-instance <id>] \
  [--server-port <port>] [--db-port <port>] [--seed-mode minimal|full] \
  [--no-seed] [--force]

# Print worktree environment for the current directory
pnpm paperclipai worktree env [-c, --config <path>] [--json]

# List worktrees
pnpm paperclipai worktree:list [--json]

# Show merge history between worktrees (import preview by default)
pnpm paperclipai worktree:merge-history \
  [--from <worktree>] [--to <worktree>] [--company <id-or-prefix>] \
  [--scope issues,comments] [--apply] [--dry] [--yes]

# Clean up merged/stale worktrees
pnpm paperclipai worktree:cleanup [--instance <id>]
```

Notes:

- `worktree:make` creates a new isolated instance from a source instance (seeded with config and database by default)
- `--start-point` sets the remote ref the new branch is based on (`PAPERCLIP_WORKTREE_START_POINT` env var)
- `worktree:merge-history` previews an issue/comment import plan between worktrees; pass `--apply` to execute it
- `worktree:cleanup` removes worktrees whose work has been merged (instance id defaults to the worktree name)

## Context Commands

Context profiles store defaults to avoid repeating flags:

```sh
# Set a context default
pnpm paperclipai context set --api-base http://localhost:3200 --company-id <id>

# Set a profile
pnpm paperclipai context set --profile ops --api-base http://localhost:3200

# Show the current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list [--json]

# Use a profile
pnpm paperclipai context use <profile>

# Use a context file directly
pnpm paperclipai context use <path-to-context.json>
```

To avoid storing secrets in context, use an env var reference:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

Context is stored at `~/.paperclip/context.json`.
