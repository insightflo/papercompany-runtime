---
title: Missions
summary: Mission lifecycle, delegation, governance, and recovery endpoints
---

Missions bundle a piece of work with a purpose. A mission can contain multiple workflow runs, step runs, issues, and heartbeat runs.

## List Missions

```
GET /api/companies/{companyId}/missions
```

Returns all missions in the company.

## Get Mission

```
GET /api/missions/{missionId}
```

Returns mission details.

## Create Mission

```
POST /api/companies/{companyId}/missions
{
  "title": "Q3 OKR rollout",
  "goalId": "{goalId}",
  "ownerAgentId": "{agentId}",
  "description": "Roll out quarterly objectives"
}
```

## Update Mission

```
PATCH /api/missions/{missionId}
{
  "title": "Q3 OKR rollout (revised)",
  "status": "active"
}
```

Updatable fields include `title`, `description`, `status`, and other mission attributes.

## Delete Mission

```
DELETE /api/missions/{missionId}
```

Deletes the mission. **Board operators only.**

## Human Operator Requests

```
GET /api/companies/{companyId}/missions/human-operator-requests
```

Lists missions currently waiting on a human operator decision.

## Run Supervision

```
POST /api/companies/{companyId}/missions/{missionId}/supervision/run
```

Manually triggers a supervision run for the mission.

## Recovery Advice

```
GET /api/companies/{companyId}/missions/{missionId}/recovery-advice
```

Returns recovery guidance for a stuck or failed mission.

## Delegations

```
GET /api/missions/{missionId}/delegations
```

Lists delegations issued for the mission.

```
POST /api/missions/{missionId}/delegations
{
  "targetCompanyId": "{companyId}",
  "targetOwnerAgentId": "{agentId}",
  "title": "Handle the onboarding flow",
  "description": "Details of the delegated work",
  "sourceIssueTitle": "Onboarding delegation",
  "priority": "high",
  "metadata": {}
}
```

Creates a cross-company delegation. `targetCompanyId` and `targetOwnerAgentId` are required; the caller must have access to the target company.

## Mission Agents

```
GET /api/missions/{missionId}/agents
```

Lists agents assigned to the mission.

```
POST /api/missions/{missionId}/agents
{
  "agentId": "{agentId}",
  "role": "main_executor"
}
```

Assigns an agent to the mission.

```
PATCH /api/missions/{missionId}/agents/{agentId}
{
  "role": "reviewer"
}
```

Updates an agent's role within the mission.

```
DELETE /api/missions/{missionId}/agents/{agentId}
```

Removes an agent from the mission.

## Governance Thread

```
GET /api/missions/{missionId}/governance-thread
```

Returns the governance discussion thread for the mission.

## Runtime Snapshot

```
GET /api/missions/{missionId}/runtime-snapshot
```

Returns a snapshot of the mission's current runtime state, including workflow runs, step runs, issues, and heartbeat runs.

## Linked Issues

```
GET /api/missions/{missionId}/issues
```

Lists issues linked to the mission.

## Workflow Runs

```
GET /api/missions/{missionId}/workflow-runs
```

Lists workflow runs associated with the mission.
