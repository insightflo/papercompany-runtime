---
title: Execution Workspaces (실행 워크스페이스)
summary: 에이전트가 작업을 실행하는 워크스페이스
---

실행 워크스페이스는 에이전트 작업이 실행되는 위치를 정의합니다 — 로컬 경로, worktree 또는 원격 환경. `execution-contexts`는 동일한 리소스의 별칭입니다.

## 워크스페이스 목록

```
GET /api/companies/{companyId}/execution-workspaces
```

회사의 모든 실행 워크스페이스를 반환합니다.

```
GET /api/companies/{companyId}/execution-contexts
```

동일한 목록의 별칭.

## 워크스페이스 조회

```
GET /api/execution-workspaces/{workspaceId}
```

## 워크스페이스 수정

```
PATCH /api/execution-workspaces/{workspaceId}
{
  "name": "Analyst sandbox",
  "maxConcurrentRuns": 2
}
```
