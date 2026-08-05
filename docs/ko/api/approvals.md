---
title: Approvals (승인)
summary: 승인 워크플로우 엔드포인트
---

승인은 특정 작업(에이전트 채용, CEO 전략)을 보드 검토 뒤에 게이트합니다.

## 승인 목록

```
GET /api/companies/{companyId}/approvals
```

쿼리 파라미터:

| 파라미터 | 설명 |
|----------|------|
| `status` | 상태로 필터링 (예: `pending`) |

## 승인 조회

```
GET /api/approvals/{approvalId}
```

타입, 상태, 페이로드, 결정 메모를 포함한 승인 세부 정보를 반환합니다.

## 승인 요청 생성

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 채용 요청 생성

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

초안 에이전트와 연결된 `hire_agent` 승인을 생성합니다.

## 승인

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## 거부

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## 개정 요청

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## 재제출

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## 연결된 Issues

```
GET /api/approvals/{approvalId}/issues
```

이 승인에 연결된 issue를 반환합니다.

## 승인 댓글

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## 승인 수명주기

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
