---
title: Workflows (워크플로우)
summary: 워크플로우 정의, 실행, 스텝 실행, 에이전트 API 엔드포인트
---

워크플로우는 에이전트 작업을 오케스트레이션하는 DAG 기반 절차입니다. 워크플로우 실행은 워크플로우 정의를 실행하여, issue와 heartbeat 실행에 매핑되는 스텝 실행을 생성합니다.

## 워크플로우 정의

### 워크플로우 목록

```
GET /api/companies/{companyId}/workflows
```

회사의 모든 워크플로우 정의를 반환합니다.

### 워크플로우 조회

```
GET /api/workflows/{workflowId}
```

단일 워크플로우 정의를 반환합니다.

### 워크플로우 생성

```
POST /api/companies/{companyId}/workflows
{
  "name": "Weekly briefing",
  "description": "Compile status report",
  "steps": []
}
```

### 워크플로우 수정

```
PATCH /api/workflows/{workflowId}
{
  "name": "Weekly briefing v2"
}
```

### 워크플로우 삭제

```
DELETE /api/workflows/{workflowId}
```

워크플로우 정의를 삭제합니다.

### 워크플로우 개요

```
GET /api/companies/{companyId}/workflows/overview
```

워크플로우와 최근 실행 상태의 요약을 반환합니다.

## 워크플로우 도구

워크플로우는 회사 도구 레지스트리의 도구를 참조할 수 있습니다.

### 도구 목록

```
GET /api/companies/{companyId}/workflows/tools
```

워크플로우에서 사용할 수 있는 도구를 나열합니다.

### 에이전트에게 도구 부여

```
POST /api/companies/{companyId}/workflows/tools/grants
{
  "agentId": "{agentId}",
  "toolName": "research-search"
}
```

특정 에이전트에게 워크플로우 도구 접근 권한을 부여합니다.

### 에이전트의 도구 부여 취소

```
DELETE /api/companies/{companyId}/workflows/tools/grants
{
  "agentId": "{agentId}",
  "toolName": "research-search"
}
```

에이전트의 워크플로우 도구 접근 권한을 취소합니다.

### 도구 레지스트리에서 동기화

```
POST /api/companies/{companyId}/workflows/tools/sync-from-tool-registry
```

회사 도구 레지스트리에서 워크플로우 도구를 다시 동기화합니다.

### QA 캡 수용 활성화

```
POST /api/companies/{companyId}/workflows/qa-cap-acceptance/enable
```

워크플로우에 대한 QA 기능 수용을 활성화합니다.

## 워크플로우 실행

### 실행 목록

```
GET /api/companies/{companyId}/workflow-runs
```

회사의 워크플로우 실행을 나열합니다.

### 워크플로우별 실행 목록

```
GET /api/workflows/{workflowId}/runs
```

### 실행 생성

```
POST /api/workflows/{workflowId}/runs
{
  "runDate": "2026-08-05"
}
```

워크플로우의 새 실행을 시작합니다.

### 실행 조회

```
GET /api/workflow-runs/{runId}
```

### 실행 상세 조회

```
GET /api/workflow-runs/{runId}/detail
```

스텝 실행, issue, heartbeat 실행을 포함한 전체 실행 상세를 반환합니다.

### 실행 재개

```
POST /api/workflow-runs/{runId}/resume
```

일시 중지되거나 막힌 워크플로우 실행을 재개합니다.

### 실행 취소

```
POST /api/workflow-runs/{runId}/cancel
```

워크플로우 실행을 취소합니다.

## 스텝 실행

### 스텝 재실행

```
POST /api/workflow-step-runs/{stepRunId}/rerun
```

단일 스텝 실행을 다시 실행합니다.

## 수동 완료

```
POST /api/issues/{issueId}/workflow/manual-complete
```

issue 뒤의 워크플로우 스텝을 수동으로 완료로 표시합니다.

## 에이전트 API

에이전트는 heartbeat 중에 다음 엔드포인트를 통해 워크플로우 결과를 보고합니다.

### 산출물 등록

```
POST /api/issues/{issueId}/workflow/artifacts
{
  "path": "report.md",
  "title": "Market analysis",
  "type": "artifact",
  "summary": "Analysis of market conditions",
  "isPrimary": true
}
```

로컬 산출물을 등록합니다. `type`은 `artifact` 또는 `document`입니다. `preview_url` 변형도 허용됩니다 (`{ "type": "preview_url", "url": "https://...", "title": "..." }`).

### 평결 게시

```
POST /api/issues/{issueId}/workflow/verdict
{
  "verdict": "pass",
  "reason": "Evidence meets acceptance criteria"
}
```

`verdict`는 `pass` 또는 `request_changes`입니다. `request_changes`인 경우 선택적으로 `nonblockingAcceptance` 객체(`{ "classification": "nonblocking", "limitations": ["..."] }`)를 함께 보낼 수 있습니다.

### 미션 플랜 QA 평결 게시

```
POST /api/issues/{issueId}/mission-plan-qa/verdict
{
  "verdict": "pass",
  "diagnostics": []
}
```

`verdict`는 `pass` 또는 `request_changes`이며, `diagnostics`는 선택적인 객체 배열입니다.

### 미션 플랜 결정 게시

```
POST /api/issues/{issueId}/mission-plan-decision
{
  "decision": { "approved": true, "note": "Proceed with plan" }
}
```

`decision`은 자유 형식 객체입니다.

### 워크플로우 완료

```
POST /api/issues/{issueId}/workflow/complete
{
  "comment": "All steps finished"
}
```

### 소유자 복구 결정

```
POST /api/issues/{issueId}/owner-recovery/decision
{
  "decision": "retry_source_issue",
  "reason": "Transient failure",
  "nextAction": "Retry the step",
  "evidence": "Run log reference",
  "targetAgentId": "{agentId}"
}
```

막힌 스텝에 대한 미션 소유자의 복구 결정을 보고합니다. `decision`은 `request_input`, `retry_source_issue`, `reassign_source_issue`, `replan_mission`, `escalate`, `report_impossible`, `recover_artifact`, `no_action_waiting` 중 하나입니다. `reassign_source_issue`는 같은 회사의 `targetAgentId`가 필요합니다.
