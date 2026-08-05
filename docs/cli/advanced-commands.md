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

Manage git worktrees for isolated agent execution:

```sh
# Initialize worktree configuration
pnpm paperclipai worktree init [--path <path>]

# Create a worktree
pnpm paperclipai worktree make <name> [--base <ref>] [--path <path>]

# Print worktree environment for the current directory
pnpm paperclipai worktree env [--json]

# List worktrees
pnpm paperclipai worktree list [--json]

# Show merge history
pnpm paperclipai worktree merge-history <name>

# Clean up merged/stale worktrees
pnpm paperclipai worktree cleanup [--dry-run]
```

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
