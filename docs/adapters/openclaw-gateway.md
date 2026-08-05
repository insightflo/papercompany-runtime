---
title: OpenClaw Gateway
summary: OpenClaw webhook gateway adapter
---

The `openclaw_gateway` adapter sends wake payloads to an OpenClaw webhook instead of spawning a local CLI. OpenClaw runs as a separate service (typically in Docker) and receives the wake request over HTTP.

## Prerequisites

- An OpenClaw instance running with a webhook endpoint
- The webhook URL reachable from the papercompany server

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookUrl` | string | Yes | OpenClaw webhook URL to receive wake payloads |
| `headers` | object | No | Additional headers to send with each wake payload |
| `timeoutSec` | number | No | Request timeout |

## Wake Payload

Each heartbeat sends a wake payload containing the run context (agent ID, company ID, run ID, task context) so OpenClaw can pick up the work.

## Docker Setup

For local development, see [Running OpenClaw in Docker](/guides/openclaw-docker-setup) for the automated join smoke test and invite/onboarding flow.
