---
title: Missions (미션)
summary: 미션 수명주기, 위임, 거버넌스, 복구 엔드포인트
---

미션은 목적과 함께 작업 묶음을 구성합니다. 미션은 여러 워크플로우 실행, 스텝 실행, issue, heartbeat 실행을 포함할 수 있습니다.

## 미션 목록

```
GET /api/companies/{companyId}/missions
```

회사의 모든 미션을 반환합니다.

## 미션 조회

```
GET /api/missions/{missionId}
```

미션 세부 정보를 반환합니다.

## 미션 생성

```
POST /api/companies/{companyId}/missions
{
  "title": "Q3 OKR rollout",
  "goalId": "{goalId}",
  "ownerAgentId": "{agentId}",
  "description": "Roll out quarterly objectives"
}
```

## 미션 수정

```
PATCH /api/missions/{missionId}
{
  "title": "Q3 OKR rollout (revised)",
  "status": "active"
}
```

수정 가능한 필드에는 `title`, `description`, `status` 및 기타 미션 속성이 포함됩니다.

## 미션 삭제

```
DELETE /api/missions/{missionId}
```

미션을 삭제합니다. **보드 운영자만 가능.**

## 인간 운영자 요청

```
GET /api/companies/{companyId}/missions/human-operator-requests
```

현재 인간 운영자 결정을 기다리는 미션을 나열합니다.

## 감독 실행

```
POST /api/companies/{companyId}/missions/{missionId}/supervision/run
```

미션에 대한 감독 실행을 수동으로 트리거합니다.

## 복구 조언

```
GET /api/companies/{companyId}/missions/{missionId}/recovery-advice
```

막히거나 실패한 미션에 대한 복구 지침을 반환합니다.

## 위임(Delegations)

```
GET /api/missions/{missionId}/delegations
```

미션에 대해 발급된 위임을 나열합니다.

```
POST /api/missions/{missionId}/delegations
{
  "agentId": "{agentId}",
  "scope": "task",
  "instructions": "Handle the onboarding flow"
}
```

새 위임을 생성합니다.

## 미션 에이전트

```
GET /api/missions/{missionId}/agents
```

미션에 할당된 에이전트를 나열합니다.

```
POST /api/missions/{missionId}/agents
{
  "agentId": "{agentId}",
  "role": "main_executor"
}
```

에이전트를 미션에 할당합니다.

```
PATCH /api/missions/{missionId}/agents/{agentId}
{
  "role": "reviewer"
}
```

미션 내에서 에이전트의 역할을 업데이트합니다.

```
DELETE /api/missions/{missionId}/agents/{agentId}
```

미션에서 에이전트를 제거합니다.

## 거버넌스 스레드

```
GET /api/missions/{missionId}/governance-thread
```

미션의 거버넌스 토론 스레드를 반환합니다.

## 런타임 스냅샷

```
GET /api/missions/{missionId}/runtime-snapshot
```

워크플로우 실행, 스텝 실행, issue, heartbeat 실행을 포함한 미션의 현재 런타임 상태 스냅샷을 반환합니다.

## 연결된 Issues

```
GET /api/missions/{missionId}/issues
```

미션에 연결된 issue를 나열합니다.

## 워크플로우 실행

```
GET /api/missions/{missionId}/workflow-runs
```

미션과 연관된 워크플로우 실행을 나열합니다.
