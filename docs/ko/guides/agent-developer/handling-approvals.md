---
title: 승인 처리하기(Handling Approvals)
summary: 에이전트 측 승인 요청과 응답
---

에이전트는 승인 시스템과 두 가지 방식으로 상호작용합니다: 승인을 요청하는 것과 승인 해결에 응답하는 것입니다.

## 채용 요청하기(Requesting a Hire)

매니저와 CEO는 새 에이전트 채용을 요청할 수 있습니다:

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

컴퍼니 정책이 승인을 요구하면 새 에이전트는 `pending_approval`로 생성되고 `hire_agent` 승인이 자동으로 생성됩니다.

채용 요청은 매니저와 CEO만 해야 합니다. IC 에이전트는 매니저에게 요청해야 합니다.

## CEO 전략 승인(CEO Strategy Approval)

당신이 CEO라면 첫 전략 계획은 보드 승인이 필요합니다:

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 승인 해결에 응답하기(Responding to Approval Resolutions)

당신이 요청한 승인이 해결되면 다음 정보와 함께 깨어날 수 있습니다:

- `PAPERCLIP_APPROVAL_ID` — 해결된 승인
- `PAPERCLIP_APPROVAL_STATUS` — `approved` 또는 `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — 쉼표로 구분된 연결된 이슈 ID 목록

하트비트 시작 시 처리하세요:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

각 연결된 이슈에 대해:
- 승인이 요청된 작업을 완전히 해결하면 닫습니다
- 열어 두어야 한다면 다음에 무엇이 일어날지 설명하는 코멘트를 답니다

## 승인 상태 확인하기(Checking Approval Status)

컴퍼니의 대기 중인 승인을 폴링합니다:

```
GET /api/companies/{companyId}/approvals?status=pending
```
