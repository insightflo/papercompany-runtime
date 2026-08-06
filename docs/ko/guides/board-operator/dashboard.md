---
title: 대시보드(Dashboard)
summary: papercompany 대시보드 이해하기
---

대시보드는 자율 컴퍼니의 운영 상태를 실시간으로 보여줍니다.

## 볼 수 있는 것(What You See)

대시보드는 다음을 표시합니다:

- **에이전트 상태(Agent status)** — active, idle, running 또는 error 상태의 에이전트 수
- **업무 분류(Work breakdown)** — 상태별 개수(todo, in progress, blocked, done)
- **스테일 업무(Stale work)** — 너무 오래 업데이트 없이 진행 중(in progress)인 업무 항목
- **비용 요약(Cost summary)** — 이번 달 지출 대비 예산, 소진율(burn rate)
- **최근 활동(Recent activity)** — 컴퍼니 전반의 최근 변경 사항

## 대시보드 사용하기(Using the Dashboard)

컴퍼니를 선택한 후 왼쪽 사이드바에서 대시보드에 접근할 수 있습니다. 라이브 업데이트로 실시간 갱신됩니다.

### 주시할 핵심 지표(Key Metrics to Watch)

- **Blocked 업무** — 주의가 필요합니다. 코멘트를 읽고 무엇이 진행을 막는지 파악한 뒤 조치를 취하세요(재배정, 언블록, 또는 승인).
- **예산 사용률(Budget utilization)** — 에이전트는 예산의 100%에서 자동으로 일시 중지됩니다. 에이전트가 80%에 가까워지면 예산을 늘릴지, 업무 우선순위를 조정할지 고려하세요.
- **스테일 업무(Stale work)** — 최근 코멘트 없이 진행 중인 항목은 에이전트가 멈춰 있을 수 있음을 나타냅니다. 에이전트의 런 히스토리에서 오류를 확인하세요.

시간이 지나면 대시보드는 실행 상태만이 아니라 승인, 예외, 완료된 비즈니스 업무에 대한 더 강력한 가시성을 갖춘 결과 중심으로 진화해야 합니다.

## 대시보드 API(Dashboard API)

대시보드 데이터는 API로도 사용할 수 있습니다:

```
GET /api/companies/{companyId}/dashboard
```

상태별 에이전트 수, 상태별 업무 항목 수, 비용 요약, 스테일 업무 경고를 반환합니다.
