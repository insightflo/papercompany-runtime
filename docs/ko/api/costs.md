---
title: Costs (비용)
summary: 비용 이벤트, 요약, 예산 관리
---

에이전트, 프로젝트, 회사 전반의 토큰 사용량과 지출을 추적합니다.

## 비용 이벤트 보고

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

일반적으로 각 heartbeat 후 adapter가 자동으로 보고합니다.

## 회사 비용 요약

```
GET /api/companies/{companyId}/costs/summary
```

이번 달의 총 지출, 예산, 사용률을 반환합니다.

## 에이전트별 비용

```
GET /api/companies/{companyId}/costs/by-agent
```

이번 달의 에이전트별 비용 내역을 반환합니다.

## 프로젝트별 비용

```
GET /api/companies/{companyId}/costs/by-project
```

이번 달의 프로젝트별 비용 내역을 반환합니다.

## 에이전트 모델별 비용

```
GET /api/companies/{companyId}/costs/by-agent-model
```

## 제공자별 비용

```
GET /api/companies/{companyId}/costs/by-provider
```

## 청구 주체별 비용

```
GET /api/companies/{companyId}/costs/by-biller
```

## 재무 이벤트

```
POST /api/companies/{companyId}/finance-events
{
  "kind": "expense",
  "amountCents": 5000,
  "description": "External tool subscription"
}
```

외부 재무 이벤트(토큰이 아닌 지출)를 기록합니다.

## 재무 요약

```
GET /api/companies/{companyId}/costs/finance-summary
```

## 청구 주체별 재무

```
GET /api/companies/{companyId}/costs/finance-by-biller
```

## 종류별 재무

```
GET /api/companies/{companyId}/costs/finance-by-kind
```

## 재무 이벤트

```
GET /api/companies/{companyId}/costs/finance-events
```

## 윈도우 지출

```
GET /api/companies/{companyId}/costs/window-spend
```

현재 청구 윈도우의 지출을 반환합니다.

## 쿼터 윈도우

```
GET /api/companies/{companyId}/costs/quota-windows
```

쿼터 윈도우와 그 사용률을 나열합니다.

## 예산 관리

### 예산 개요

```
GET /api/companies/{companyId}/budgets/overview
```

### 회사 예산 설정

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 에이전트 예산 설정

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

### 회사 예산 업데이트

```
PATCH /api/companies/{companyId}/budgets
{
  "monthlyBudgetCents": 200000
}
```

### 에이전트 예산 업데이트

```
PATCH /api/agents/{agentId}/budgets
{
  "monthlyBudgetCents": 8000
}
```

### 예산 정책 생성

```
POST /api/companies/{companyId}/budgets/policies
{
  "kind": "hard_stop",
  "thresholdCents": 500000
}
```

### 예산 인시던트 해결

```
POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve
{
  "resolution": "increased_budget"
}
```

예산 집행 인시던트를 해결합니다.

## 예산 집행

| 임계값 | 효과 |
|--------|------|
| 80% | 소프트 알림 — 에이전트는 중요 태스크에 집중해야 함 |
| 100% | 하드 스톱 — 에이전트가 자동으로 일시 중지됨 |

예산 윈도우는 매월 1일(UTC)에 리셋됩니다.
