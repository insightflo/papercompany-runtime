---
title: Metrics & Health
summary: Health checks and operational metrics
---

Health and metrics endpoints are mounted under `/api` and are used by load balancers and operators.

## Health Check

```
GET /api/health
```

Returns the control-plane health status.

```
GET /api/health/
```

Alias with trailing slash.

## Metrics

```
GET /api/metrics
```

Returns operational metrics in Prometheus text format.

```
GET /api/metrics/json
```

Returns the same metrics as JSON.

## Webhook

### SRB Webhook

```
POST /api/srb/webhook
```

Inbound webhook for the SRB (settlement) integration.

## LLM Agent Configuration

The LLM endpoints are mounted at **app level**, not under `/api`:

```
GET /llms/agent-configuration.txt
GET /llms/agent-icons.txt
GET /llms/agent-configuration/{adapterType}.txt
```

These return agent configuration and icon bundles for LLM tooling.
