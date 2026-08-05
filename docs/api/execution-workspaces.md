---
title: Execution Workspaces
summary: Workspaces where agents execute work
---

Execution workspaces define where agent work runs — local paths, worktrees, or remote environments. `execution-contexts` is an alias for the same resource.

## List Workspaces

```
GET /api/companies/{companyId}/execution-workspaces
```

Returns all execution workspaces in the company.

```
GET /api/companies/{companyId}/execution-contexts
```

Alias for the same list.

## Get Workspace

```
GET /api/execution-workspaces/{workspaceId}
```

## Update Workspace

```
PATCH /api/execution-workspaces/{workspaceId}
{
  "name": "Analyst sandbox",
  "maxConcurrentRuns": 2
}
```
