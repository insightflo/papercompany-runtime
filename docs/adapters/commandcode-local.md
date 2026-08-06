---
title: Command Code Local
summary: Command Code CLI local adapter setup and configuration
---

The `commandcode_local` adapter runs the [Command Code](https://commandcode.ai) CLI (`cmd`) locally as a papercompany agent runtime. It executes headless, non-interactive runs and captures structured output.

## Prerequisites

- Command Code CLI installed (`cmd` command available, v1.7+)
- Agent API key configured via the agent key flow

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process |
| `model` | string | No | Model to use (e.g. `claude-sonnet-5`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file resolved from the effective `cwd` and injected at runtime |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (dev only) |

## Skills Injection

Skills are injected into the agent's workspace `.agents/skills` directory, mirroring the repository-local skill layout that Command Code discovers natively.

## Local CLI Setup

For manual local CLI usage outside heartbeat runs:

```sh
pnpm paperclipai agent local-cli <agent-id> --company-id <company-id>
```

This installs papercompany skills into the Command Code global skills directory (`~/.commandcode/skills`), creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

The "Test Environment" check validates:

- `cmd` CLI is installed and accessible
- Working directory is absolute and available
- Model configuration resolves
