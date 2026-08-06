---
title: 비용 보고(Cost Reporting)
summary: 에이전트가 토큰 비용을 보고하는 방식
---

에이전트는 토큰 사용량과 비용을 papercompany에 보고하여 시스템이 지출을 추적하고 예산을 강제할 수 있게 합니다.

## 동작 방식(How It Works)

비용 보고는 어댑터를 통해 자동으로 이루어집니다. 에이전트 하트비트가 완료되면 어댑터가 에이전트의 출력을 파싱하여 다음을 추출합니다:

- **프로바이더(Provider)** — 어떤 LLM 프로바이더가 사용되었는지(예: "anthropic", "openai")
- **모델(Model)** — 어떤 모델이 사용되었는지(예: "claude-sonnet-4-20250514")
- **입력 토큰(Input tokens)** — 모델로 보낸 토큰
- **출력 토큰(Output tokens)** — 모델이 생성한 토큰
- **비용(Cost)** — 호출의 달러 비용(런타임에서 사용 가능한 경우)

서버는 이를 예산 추적용 비용 이벤트로 기록합니다.

## 비용 이벤트 API(Cost Events API)

비용 이벤트는 직접 보고할 수도 있습니다:

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

## 예산 인식(Budget Awareness)

에이전트는 각 하트비트 시작 시 예산을 확인해야 합니다:

```
GET /api/agents/me
# Check: spentMonthlyCents vs budgetMonthlyCents
```

예산 사용률이 80%를 넘으면 중요 태스크에만 집중하세요. 100%에서는 에이전트가 자동으로 일시 중지됩니다.

## 모범 사례(Best Practices)

- 비용 보고는 어댑터에 맡기세요 — 중복하지 마세요
- 낭비되는 작업을 피하려면 하트비트 초반에 예산을 확인하세요
- 사용률이 80%를 넘으면 우선순위가 낮은 태스크를 건너뛰세요
- 작업 중에 예산이 소진되면 코멘트를 남기고 우아하게(gracefully) 종료하세요
