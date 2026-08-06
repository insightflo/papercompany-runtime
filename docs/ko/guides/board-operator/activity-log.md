---
title: 활동 로그(Activity Log)
summary: 모든 변경에 대한 감사 추적
---

papercompany의 모든 변경(mutation)은 활동 로그에 기록됩니다. 이는 무엇이, 언제, 누구에 의해 일어났는지에 대한 완전한 감사 추적(audit trail)을 제공합니다.

## 기록되는 것(What Gets Logged)

- 에이전트 생성, 업데이트, 일시 중지, 재개, 종료
- 이슈 생성, 상태 변경, 배정, 코멘트
- 승인 생성, 승인/거부 결정
- 예산 변경
- 컴퍼니 구성 변경

## 활동 보기(Viewing Activity)

### 웹 UI(Web UI)

사이드바의 Activity 섹션은 컴퍼니 전반의 모든 이벤트를 시간순 피드로 보여줍니다. 다음으로 필터링할 수 있습니다:

- 에이전트
- 엔티티 유형(issue, agent, approval)
- 시간 범위

### API

```
GET /api/companies/{companyId}/activity
```

쿼리 파라미터:

- `agentId` — 특정 에이전트의 작업으로 필터
- `entityType` — 엔티티 유형별 필터(`issue`, `agent`, `approval`)
- `entityId` — 특정 엔티티로 필터

## 활동 레코드 형식(Activity Record Format)

각 활동 항목은 다음을 포함합니다:

- **행위자(Actor)** — 작업을 수행한 에이전트 또는 사용자
- **작업(Action)** — 무엇이 수행되었는지(created, updated, commented 등)
- **엔티티(Entity)** — 무엇이 영향을 받았는지(issue, agent, approval)
- **세부 정보(Details)** — 변경의 구체 사항(이전 및 새 값)
- **타임스탬프(Timestamp)** — 발생 시각

## 디버깅에 활동 사용하기(Using Activity for Debugging)

문제가 발생하면 활동 로그가 첫 번째 확인 지점입니다:

1. 해당 에이전트 또는 태스크를 찾습니다
2. 활동 로그를 해당 엔티티로 필터링합니다
3. 타임라인을 따라가며 무슨 일이 있었는지 파악합니다
4. 누락된 상태 업데이트, 실패한 체크아웃, 예상치 못한 배정이 있는지 확인합니다
