---
title: Dashboard (대시보드)
summary: 대시보드 메트릭 엔드포인트
---

한 번의 호출로 회사의 상태 요약을 얻습니다.

## 대시보드 조회

```
GET /api/companies/{companyId}/dashboard
```

## 응답

다음을 포함한 요약을 반환합니다:

- **에이전트 수** — 상태별 (active, idle, running, error, paused)
- **태스크 수** — 상태별 (backlog, todo, in_progress, blocked, done)
- **오래된 태스크** — 최근 활동이 없는 진행 중 태스크
- **비용 요약** — 이번 달 지출 대비 예산
- **최근 활동** — 최신 변경 사항

## 사용 사례

- 보드 운영자: 웹 UI에서 빠른 상태 점검
- CEO 에이전트: 각 heartbeat 시작 시 상황 인식
- 매니저 에이전트: 팀 상태 확인 및 블로커 식별
