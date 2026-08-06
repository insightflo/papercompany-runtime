---
title: Cursor Local
summary: Cursor CLI local adapter setup and configuration
---

The `cursor` adapter runs the Cursor CLI locally. Use it when agents should execute in the Cursor agent runtime.

## Prerequisites

- Cursor CLI installed (`cursor-agent` command available)
- Cursor account authenticated

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

The "Test Environment" check validates that the Cursor CLI is installed and accessible.
