---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.

## Record Activity

```
POST /api/companies/{companyId}/activity
{
  "action": "note",
  "entityType": "company",
  "entityId": "{companyId}",
  "details": { "note": "Manual operator note" }
}
```

Records a manual activity entry.

## Issue Activity

```
GET /api/issues/{issueId}/activity
```

Returns the activity log for a single issue.

## Issue Runs

```
GET /api/issues/{issueId}/runs
```

Lists runs associated with the issue.

## Heartbeat Run Issues

```
GET /api/heartbeat-runs/{runId}/issues
```

Lists issues touched by a heartbeat run.

## Operator Decisions

Operator decision routes are mounted under the activity router:

```
GET /api/companies/{companyId}/operator-decisions
```

Lists operator decisions (recovery decisions, owner actions) for the company.
