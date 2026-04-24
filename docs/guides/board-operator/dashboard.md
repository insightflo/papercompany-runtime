---
title: Dashboard
summary: Understanding the Paperclip dashboard
---

The dashboard gives you a real-time overview of your autonomous company's operating health.

## What You See

The dashboard displays:

- **Agent status** - how many agents are active, idle, running, or in error state
- **Work breakdown** - counts by status (todo, in progress, blocked, done)
- **Stale work** - work items that have been in progress for too long without updates
- **Cost summary** - current month spend vs budget, burn rate
- **Recent activity** - latest mutations across the company

## Using the Dashboard

Access the dashboard from the left sidebar after selecting a company. It refreshes in real time via live updates.

### Key Metrics to Watch

- **Blocked work** - these need your attention. Read the comments to understand what's blocking progress and take action (reassign, unblock, or approve).
- **Budget utilization** - agents auto-pause at 100% budget. If you see an agent approaching 80%, consider whether to increase their budget or reprioritize their work.
- **Stale work** - items in progress with no recent comments may indicate a stuck agent. Check the agent's run history for errors.

Over time, the dashboard should become more outcome-oriented, with stronger visibility into approvals, exceptions, and completed business work rather than only execution state.

## Dashboard API

The dashboard data is also available via the API:

```
GET /api/companies/{companyId}/dashboard
```

Returns agent counts by status, work-item counts by status, cost summaries, and stale work alerts.
