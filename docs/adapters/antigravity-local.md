---
title: Antigravity Local
summary: Antigravity CLI local adapter setup and configuration
---

The `antigravity_local` adapter runs the Antigravity CLI locally.

## Prerequisites

- Antigravity CLI installed
- Antigravity account authenticated

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file resolved from the effective `cwd` and injected at runtime |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat |

## Environment Test

The "Test Environment" check validates that the Antigravity CLI is installed and accessible.
