---
title: Worktree
summary: Worktree rules and proposals
---

Worktree rules govern how agent workspaces are structured, and proposals propose workspace changes for approval.

## Worktree Rules

### List Rules

```
GET /api/companies/{companyId}/worktree/rules
```

### Create Rule

```
POST /api/companies/{companyId}/worktree/rules
{
  "name": "Isolation required",
  "pattern": "**/*.ts",
  "action": "isolate"
}
```

### Get Rule

```
GET /api/worktree/rules/{ruleId}
```

### Update Rule

```
PATCH /api/worktree/rules/{ruleId}
{
  "action": "guard"
}
```

### Delete Rule

```
DELETE /api/worktree/rules/{ruleId}
```

## Worktree Proposals

### List Proposals

```
GET /api/companies/{companyId}/worktree/proposals
```

### Create Proposal

```
POST /api/companies/{companyId}/worktree/proposals
{
  "title": "Move adapter docs",
  "changes": []
}
```

### Get Proposal

```
GET /api/worktree/proposals/{proposalId}
```

### Review Proposal

```
PATCH /api/worktree/proposals/{proposalId}/review
{
  "decision": "approved",
  "reasoning": "Safe to apply"
}
```

Reviews a proposal.
