---
title: Hermes Local
summary: Hermes local adapter setup and configuration
---

The `hermes_local` adapter runs Hermes locally as a papercompany agent runtime.

## Prerequisites

- Hermes CLI installed and configured
- `HERMES_HOME` pointing at the Hermes home directory (optional)

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

The "Test Environment" check validates that the Hermes CLI is installed and accessible.

## Model Listing

`listModels` returns only models from **authenticated providers**, verified via Hermes' own `list_available_providers()` (same check as the `hermes model` picker), with an `auth.json` `credential_pool` fallback when the venv python is unavailable. Providers with no usable credentials (e.g. a revoked `openai-codex`) are hidden from the dropdown.
