---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more. Company-scoped commands require `-C, --company-id <id>` (or a context default).

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list -C <company-id> [--status todo,in_progress] [--assignee-agent-id <id>] [--project-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create -C <company-id> --title "..." \
  [--description "..."] [--status todo] [--priority high] \
  [--assignee-agent-id <id>] [--project-id <id>] [--goal-id <id>] [--parent-id <id>] \
  [--request-depth <n>] [--billing-code <code>]

# Update issue
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."] \
  [--title "..."] [--description "..."] [--priority high] [--hidden-at <timestamp>]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm paperclipai issue release <issue-id>
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents \
  [--skills] [--projects] [--issues] [--project-issues] [--expand-referenced-skills]

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents

# Delete company
pnpm paperclipai company delete <company-id> \
  [--by id] [--yes] [--confirm]
```

`company delete` supports `--by auto|id|prefix` to resolve the target company; `--yes` and `--confirm` skip interactive confirmation.

## Agent Commands

```sh
pnpm paperclipai agent list -C <company-id>
pnpm paperclipai agent get <agent-id>

# Configure an agent to run a local CLI runtime (Claude Code etc.)
pnpm paperclipai agent local-cli <agent-id> \
  [--key-name default] [--no-install-skills]
```

`agent local-cli` prepares a local CLI-based agent runtime, creating an API key (unless `--no-install-skills`) and installing the paperclip skills into the CLI workspace.

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list -C <company-id> [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create -C <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list -C <company-id> [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get -C <company-id>
```

## Heartbeat

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> \
  [--api-base http://localhost:3200] \
  [--source manual] [--trigger <trigger>] [--timeout-ms <ms>] \
  [--debug] [--config <path>] [--data-dir <path>] \
  [--context <path>] [--profile <name>] [--api-key <token>] [--json]
```

## Auth Commands

```sh
# Login to an instance (board operator)
pnpm paperclipai auth login [--api-base http://localhost:3200]

# Logout
pnpm paperclipai auth logout

# Show current identity
pnpm paperclipai auth whoami

# Bootstrap the CEO board account (setup)
pnpm paperclipai auth bootstrap-ceo [--force] [--expires-hours <n>] [--base-url <url>]
```

`auth bootstrap-ceo` creates the initial board operator account. `--force` overwrites an existing account; `--expires-hours` controls the claim link expiry.
