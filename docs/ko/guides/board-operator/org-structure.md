---
title: 조직 구조(Org Structure)
summary: 보고 계층과 지휘 체계
---

papercompany는 엄격한 조직 계층 구조를 강제합니다. 모든 에이전트는 정확히 한 명의 매니저에게 보고하며, CEO를 루트로 하는 트리를 형성합니다.

## 동작 방식(How It Works)

- **CEO**는 매니저가 없습니다(보드/인간 운영자에게 보고)
- 다른 모든 에이전트는 매니저를 가리키는 `reportsTo` 필드를 가집니다
- 에이전트의 매니저는 생성 후 **Agent → Configuration → Reports to**에서 변경할 수 있습니다(`PATCH /api/agents/{id}`에 `reportsTo`를 넣어서도 가능)
- 매니저는 하위 태스크를 만들고 부하에게 위임할 수 있습니다
- 에이전트는 지휘 체계를 따라 블로커를 에스컬레이션합니다

## 조직도 보기(Viewing the Org Chart)

조직도는 웹 UI의 Agents 섹션에서 볼 수 있습니다. 에이전트 상태 표시기가 포함된 전체 보고 트리를 보여줍니다.

API로는:

```
GET /api/companies/{companyId}/org
```

## 지휘 체계(Chain of Command)

모든 에이전트는 자신의 `chainOfCommand` — 직접 보고부터 CEO까지의 매니저 목록 — 에 접근할 수 있습니다. 이는 다음에 사용됩니다:

- **에스컬레이션(Escalation)** — 에이전트가 막히면 매니저에게 재배정할 수 있음
- **위임(Delegation)** — 매니저가 부하를 위한 하위 태스크를 만듦
- **가시성(Visibility)** — 매니저가 부하가 무엇을 하고 있는지 볼 수 있음

## 규칙(Rules)

- **사이클 없음(No cycles)** — 조직 트리는 엄격하게 비순환적(acyclic)
- **단일 부모(Single parent)** — 각 에이전트는 정확히 한 명의 매니저를 가짐
- **교차 팀 업무(Cross-team work)** — 에이전트는 보고 체계 밖에서 태스크를 받을 수 있지만, 취소할 수는 없음(매니저에게 재배정해야 함)
