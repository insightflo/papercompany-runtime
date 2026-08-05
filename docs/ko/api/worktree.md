---
title: Worktree
summary: Worktree 규칙과 제안
---

Worktree 규칙은 에이전트 워크스페이스가 어떻게 구성되는지를 규율하고, 제안(proposal)은 승인을 위해 워크스페이스 변경을 제안합니다.

## Worktree 규칙

### 규칙 목록

```
GET /api/companies/{companyId}/worktree/rules
```

### 규칙 생성

```
POST /api/companies/{companyId}/worktree/rules
{
  "name": "Isolation required",
  "pattern": "**/*.ts",
  "action": "isolate"
}
```

### 규칙 조회

```
GET /api/worktree/rules/{ruleId}
```

### 규칙 수정

```
PATCH /api/worktree/rules/{ruleId}
{
  "action": "guard"
}
```

### 규칙 삭제

```
DELETE /api/worktree/rules/{ruleId}
```

## Worktree 제안

### 제안 목록

```
GET /api/companies/{companyId}/worktree/proposals
```

### 제안 생성

```
POST /api/companies/{companyId}/worktree/proposals
{
  "title": "Move adapter docs",
  "changes": []
}
```

### 제안 조회

```
GET /api/worktree/proposals/{proposalId}
```

### 제안 검토

```
PATCH /api/worktree/proposals/{proposalId}/review
{
  "decision": "approved",
  "reasoning": "Safe to apply"
}
```

제안을 검토합니다.
