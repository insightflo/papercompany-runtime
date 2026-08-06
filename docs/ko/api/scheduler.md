---
title: Scheduler (스케줄러)
summary: 반복 스케줄과 스케줄러 상태
---

스케줄은 워크플로우 실행과 루틴을 반복적으로 실행시킵니다.

## 스케줄 목록

```
GET /api/companies/{companyId}/schedules
```

회사의 모든 스케줄을 반환합니다.

## 스케줄 생성

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

스케줄을 생성합니다.

## 스케줄 조회

```
GET /api/schedules/{scheduleId}
```

## 스케줄 수정

```
PATCH /api/schedules/{scheduleId}
{
  "cronExpression": "0 10 * * *",
  "enabled": false
}
```

## 스케줄 삭제

```
DELETE /api/schedules/{scheduleId}
```

## 스케줄러 상태

```
GET /api/state
```

소유권 모드(네이티브 vs 플러그인)와 레인 상태를 포함한 현재 스케줄러 상태를 반환합니다.
