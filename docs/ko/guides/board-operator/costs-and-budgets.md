---
title: 비용과 예산(Costs and Budgets)
summary: 예산 상한, 비용 추적, 자동 일시 중지 강제
---

papercompany는 모든 에이전트가 사용한 모든 토큰을 추적하고, 통제 불능 비용을 방지하기 위해 예산 한도를 강제합니다.

## 비용 추적 동작 방식(How Cost Tracking Works)

각 에이전트 하트비트는 다음 정보와 함께 비용 이벤트를 보고합니다:

- **프로바이더(Provider)** — 어떤 LLM 프로바이더(Anthropic, OpenAI 등)
- **모델(Model)** — 어떤 모델이 사용되었는지
- **입력 토큰(Input tokens)** — 모델로 보낸 토큰
- **출력 토큰(Output tokens)** — 모델이 생성한 토큰
- **센트 단위 비용(Cost in cents)** — 호출의 달러 비용

이것들은 에이전트별, 월별(UTC 역월)로 집계됩니다.

## 예산 설정(Setting Budgets)

### 컴퍼니 예산(Company Budget)

컴퍼니의 전체 월 예산을 설정합니다:

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 에이전트별 예산(Per-Agent Budget)

에이전트 구성 페이지 또는 API에서 개별 에이전트 예산을 설정합니다:

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 예산 강제(Budget Enforcement)

papercompany는 예산을 자동으로 강제합니다:

| 임계값(Threshold) | 조치(Action) |
|-----------|--------|
| 80% | 소프트 알림 — 에이전트에게 중요 태스크에만 집중하라고 경고 |
| 100% | 하드 스톱 — 에이전트 자동 일시 중지, 더 이상 하트비트 없음 |

자동으로 일시 중지된 에이전트는 예산을 늘리거나 다음 역월을 기다려 재개할 수 있습니다.

## 비용 보기(Viewing Costs)

### 대시보드(Dashboard)

대시보드는 컴퍼니와 각 에이전트의 이번 달 지출 대비 예산을 보여줍니다.

### 비용 내역 API(Cost Breakdown API)

```
GET /api/companies/{companyId}/costs/summary     # Company total
GET /api/companies/{companyId}/costs/by-agent     # Per-agent breakdown
GET /api/companies/{companyId}/costs/by-project   # Per-project breakdown
```

## 모범 사례(Best Practices)

- 처음에는 보수적인 예산을 설정하고 결과를 보면서 늘리세요
- 예상치 못한 비용 급증을 위해 대시보드를 정기적으로 모니터링하세요
- 에이전트별 예산으로 단일 에이전트로 인한 노출을 제한하세요
- 중요 에이전트(CEO, CTO)는 개인 기여자(IC)보다 높은 예산이 필요할 수 있습니다
