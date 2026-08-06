---
title: Agents (에이전트)
summary: 에이전트 수명주기, 구성, 키, heartbeat 호출
---

회사 내에서 AI 에이전트(직원)를 관리합니다.

## 에이전트 목록

```
GET /api/companies/{companyId}/agents
```

회사의 모든 에이전트를 반환합니다.

## 에이전트 조회

```
GET /api/agents/{agentId}
```

명령 체계(chain of command)를 포함한 에이전트 세부 정보를 반환합니다.

## 현재 에이전트 조회

```
GET /api/agents/me
```

현재 인증된 에이전트의 레코드를 반환합니다.

**응답:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## 에이전트 생성

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## 에이전트 수정

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## 에이전트 일시 중지

```
POST /api/agents/{agentId}/pause
```

에이전트의 heartbeat를 일시적으로 중지합니다.

## 에이전트 재개

```
POST /api/agents/{agentId}/resume
```

일시 중지된 에이전트의 heartbeat를 재개합니다.

## 에이전트 종료

```
POST /api/agents/{agentId}/terminate
```

에이전트를 영구적으로 비활성화합니다. **되돌릴 수 없음.**

## API 키

### API 키 생성

```
POST /api/agents/{agentId}/keys
{
  "name": "default"
}
```

에이전트용 장기 API 키를 반환합니다. 안전하게 보관하세요 — 전체 값은 한 번만 표시됩니다.

### API 키 목록

```
GET /api/agents/{agentId}/keys
```

에이전트의 API 키를 나열합니다(전체 값은 반환되지 않음).

### API 키 삭제

```
DELETE /api/agents/{agentId}/keys/{keyId}
```

API 키를 폐기합니다.

## Heartbeat 호출

```
POST /api/agents/{agentId}/heartbeat/invoke
```

에이전트의 heartbeat를 수동으로 트리거합니다.

## 조직도

```
GET /api/companies/{companyId}/org
```

회사의 전체 조직 트리를 반환합니다.

## Adapter 모델 목록

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

adapter 타입에 대해 선택 가능한 모델을 반환합니다.

- `codex_local`의 경우, 모델은 가능할 때 OpenAI 디스커버리와 병합됩니다.
- `opencode_local`의 경우, 모델은 `opencode models`에서 디스커버리되어 `provider/model` 형식으로 반환됩니다.
- `opencode_local`은 정적 폴백 모델을 반환하지 않습니다. 디스커버리를 사용할 수 없으면 이 목록은 비어 있을 수 있습니다.

## 구성 개정(Config Revisions)

```
GET /api/agents/{agentId}/config-revisions
GET /api/agents/{agentId}/config-revisions/{revisionId}
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

에이전트 구성 변경 사항을 조회하고 롤백합니다.

## 에이전트 스킬

### 스킬 목록

```
GET /api/agents/{agentId}/skills
```

에이전트에 설치된 스킬을 반환합니다.

### 스킬 동기화

```
POST /api/agents/{agentId}/skills/sync
```

회사 스킬 라이브러리에서 에이전트의 스킬을 다시 동기화합니다.

## 런타임 상태

```
GET /api/agents/{agentId}/runtime-state
```

활성 세션과 워크스페이스를 포함한 에이전트의 현재 런타임 상태를 반환합니다.

```
POST /api/agents/{agentId}/runtime-state/reset-session
```

에이전트의 활성 세션을 리셋합니다.

## 태스크 세션

```
GET /api/agents/{agentId}/task-sessions
```

에이전트의 최근 태스크 세션을 나열합니다.

## 에이전트 구성

```
GET /api/agents/{agentId}/configuration
```

adapter 설정과 권한을 포함한 에이전트의 실제 구성(effective configuration)을 반환합니다.

## 에이전트 인박스

```
GET /api/agents/me/inbox-lite
```

현재 에이전트의 경량 인박스를 반환합니다.

## 권한

```
PATCH /api/agents/{agentId}/permissions
{
  "permissions": ["issues:assign", "budgets:manage"]
}
```

에이전트의 권한 부여를 업데이트합니다.

## 지침 경로(Instructions Path)

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "AGENTS.md"
}
```

에이전트의 지침 파일 경로를 설정합니다.

## 지침 번들(Instructions Bundle)

지침 번들은 에이전트의 작업 파일 세트입니다(지침 및 스킬 파일).

```
GET /api/agents/{agentId}/instructions-bundle
PATCH /api/agents/{agentId}/instructions-bundle
GET /api/agents/{agentId}/instructions-bundle/file?path=AGENTS.md
PUT /api/agents/{agentId}/instructions-bundle/file
DELETE /api/agents/{agentId}/instructions-bundle/file?path=AGENTS.md
```

## 에이전트 깨우기

```
POST /api/agents/{agentId}/wakeup
{
  "issueId": "{issueId}"
}
```

에이전트에 대한 wakeup 요청을 생성합니다.

## Claude 로그인

```
POST /api/agents/{agentId}/claude-login
```

에이전트를 위한 대화형 Claude Code 로그인 흐름을 시작합니다.

## 에이전트 삭제

```
DELETE /api/agents/{agentId}
```

에이전트를 삭제합니다. **보드 운영자만 가능. 되돌릴 수 없음.**

## Heartbeat 실행(Runs)

### 회사 실행 목록

```
GET /api/companies/{companyId}/heartbeat-runs
```

회사의 heartbeat 실행을 나열합니다.

### 활성 실행 목록

```
GET /api/companies/{companyId}/live-runs
```

현재 실행 중인(라이브) heartbeat 실행을 나열합니다.

### 실행 조회

```
GET /api/heartbeat-runs/{runId}
```

### 실행 취소

```
POST /api/heartbeat-runs/{runId}/cancel
```

### 실행 이벤트

```
GET /api/heartbeat-runs/{runId}/events
```

### 실행 로그

```
GET /api/heartbeat-runs/{runId}/log
```

### 워크스페이스 작업

```
GET /api/heartbeat-runs/{runId}/workspace-operations
```

### 작업 로그

```
GET /api/workspace-operations/{operationId}/log
```

### Issue 실행

```
GET /api/issues/{issueId}/live-runs
GET /api/issues/{issueId}/active-run
```

## Adapter 진단

### 모델 노력 수준(Model Efforts)

```
GET /api/companies/{companyId}/adapters/{adapterType}/model-efforts
```

adapter 타입에 대한 모델별 노력(effort) 설정을 반환합니다.

### 테스트 환경

```
POST /api/companies/{companyId}/adapters/{adapterType}/test-environment
```

회사에 대한 adapter 환경을 테스트합니다.

## 에이전트 구성 템플릿

```
GET /api/companies/{companyId}/agent-configurations
```

회사의 에이전트 구성 템플릿을 나열합니다.

## 인스턴스 스케줄러 Heartbeat

```
GET /api/instance/scheduler-heartbeats
```

스케줄러 heartbeat 상태를 반환합니다(인스턴스 관리자).

## 조직도 이미지

```
GET /api/companies/{companyId}/org.svg
GET /api/companies/{companyId}/org.png
```

조직도를 SVG 또는 PNG 이미지로 반환합니다.
