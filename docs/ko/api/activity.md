---
title: Activity (활동)
summary: 활동 로그 조회
---

회사 전반의 모든 변경(mutation)에 대한 감사 추적을 조회합니다.

## 활동 목록

```
GET /api/companies/{companyId}/activity
```

쿼리 파라미터:

| 파라미터 | 설명 |
|----------|------|
| `agentId` | 행위자 에이전트로 필터링 |
| `entityType` | 엔티티 타입으로 필터링 (`issue`, `agent`, `approval`) |
| `entityId` | 특정 엔티티로 필터링 |

## 활동 레코드

각 항목은 다음을 포함합니다:

| 필드 | 설명 |
|------|------|
| `actor` | 작업을 수행한 에이전트 또는 사용자 |
| `action` | 수행된 작업 (created, updated, commented 등) |
| `entityType` | 영향을 받은 엔티티의 타입 |
| `entityId` | 영향을 받은 엔티티의 ID |
| `details` | 변경 사항의 세부 내용 |
| `createdAt` | 작업이 발생한 시점 |

## 기록되는 내용

모든 변경 사항이 기록됩니다:

- Issue 생성, 수정, 상태 전환, 할당
- 에이전트 생성, 구성 변경, 일시 중지, 재개, 종료
- 승인 생성, 승인/거부 결정
- 댓글 생성
- 예산 변경
- 회사 구성 변경

활동 로그는 추가 전용(append-only)이며 변경 불가능합니다.

## 활동 기록

```
POST /api/companies/{companyId}/activity
{
  "action": "note",
  "entityType": "company",
  "entityId": "{companyId}",
  "details": { "note": "Manual operator note" }
}
```

수동 활동 항목을 기록합니다.

## Issue 활동

```
GET /api/issues/{issueId}/activity
```

단일 issue에 대한 활동 로그를 반환합니다.

## Issue 실행

```
GET /api/issues/{issueId}/runs
```

issue와 연관된 실행(run)을 나열합니다.

## Heartbeat 실행 Issues

```
GET /api/heartbeat-runs/{runId}/issues
```

heartbeat 실행이 다룬 issue를 나열합니다.

## 운영자 결정

운영자 결정 라우트는 활동 라우터 아래에 마운트됩니다:

```
GET /api/companies/{companyId}/operator-decisions
```

회사의 운영자 결정(복구 결정, 소유자 작업)을 나열합니다.
