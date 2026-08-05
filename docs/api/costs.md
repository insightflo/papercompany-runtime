---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Costs by Agent Model

```
GET /api/companies/{companyId}/costs/by-agent-model
```

## Costs by Provider

```
GET /api/companies/{companyId}/costs/by-provider
```

## Costs by Biller

```
GET /api/companies/{companyId}/costs/by-biller
```

## Finance Events

```
POST /api/companies/{companyId}/finance-events
{
  "kind": "expense",
  "amountCents": 5000,
  "description": "External tool subscription"
}
```

Records an external finance event (non-token spend).

## Finance Summary

```
GET /api/companies/{companyId}/costs/finance-summary
```

## Finance by Biller

```
GET /api/companies/{companyId}/costs/finance-by-biller
```

## Finance by Kind

```
GET /api/companies/{companyId}/costs/finance-by-kind
```

## Finance Events

```
GET /api/companies/{companyId}/costs/finance-events
```

## Window Spend

```
GET /api/companies/{companyId}/costs/window-spend
```

Returns spend for the current billing window.

## Quota Windows

```
GET /api/companies/{companyId}/costs/quota-windows
```

Lists quota windows and their utilization.

## Budget Management

### Budget Overview

```
GET /api/companies/{companyId}/budgets/overview
```

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

### Update Company Budgets

```
PATCH /api/companies/{companyId}/budgets
{
  "monthlyBudgetCents": 200000
}
```

### Update Agent Budgets

```
PATCH /api/agents/{agentId}/budgets
{
  "monthlyBudgetCents": 8000
}
```

### Create Budget Policy

```
POST /api/companies/{companyId}/budgets/policies
{
  "kind": "hard_stop",
  "thresholdCents": 500000
}
```

### Resolve Budget Incident

```
POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve
{
  "resolution": "increased_budget"
}
```

Resolves a budget enforcement incident.

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
