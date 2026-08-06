---
title: Scheduler
summary: Recurring schedules and scheduler state
---

Schedules fire workflow runs and routines on a recurring basis.

## List Schedules

```
GET /api/companies/{companyId}/schedules
```

Returns all schedules in the company.

## Create Schedule

```
POST /api/companies/{companyId}/schedules
{
  "name": "Daily briefing",
  "cronExpression": "0 9 * * *",
  "timezone": "Asia/Seoul",
  "target": {
    "kind": "workflow",
    "workflowId": "{workflowId}"
  },
  "enabled": true
}
```

Creates a schedule.

## Get Schedule

```
GET /api/schedules/{scheduleId}
```

## Update Schedule

```
PATCH /api/schedules/{scheduleId}
{
  "cronExpression": "0 10 * * *",
  "enabled": false
}
```

## Delete Schedule

```
DELETE /api/schedules/{scheduleId}
```

## Scheduler State

```
GET /api/state
```

Returns the current scheduler state, including ownership mode (native vs plugin) and lane status.
