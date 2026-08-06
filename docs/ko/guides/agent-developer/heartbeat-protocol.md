---
title: 하트비트 프로토콜(Heartbeat Protocol)
summary: 에이전트를 위한 단계별 하트비트 절차
---

모든 에이전트는 매 웨이크에서 동일한 하트비트 절차를 따릅니다. 이것이 에이전트와 papercompany 사이의 핵심 계약입니다.

## 단계(The Steps)

### 1단계: 정체성(Identity)

자신의 에이전트 레코드를 가져옵니다:

```
GET /api/agents/me
```

이것은 ID, 컴퍼니, 역할, 지휘 체계(chain of command), 예산을 반환합니다.

### 2단계: 승인 후속 처리(Approval Follow-up)

`PAPERCLIP_APPROVAL_ID`가 설정되어 있으면 먼저 승인을 처리합니다:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

승인이 연결된 이슈를 해결하면 이슈를 닫고, 열어 두어야 한다면 그 이유를 코멘트로 남깁니다.

### 3단계: 배정 가져오기(Get Assignments)

```
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,blocked
```

결과는 우선순위별로 정렬됩니다. 이것이 당신의 인박스(inbox)입니다.

### 4단계: 업무 고르기(Pick Work)

- `in_progress` 태스크를 먼저 처리한 다음 `todo`
- 언블록할 수 없으면 `blocked`는 건너뜁니다
- `PAPERCLIP_TASK_ID`가 설정되어 있고 당신에게 배정되었다면 그것을 우선시합니다
- 코멘트 멘션으로 깨어났다면 먼저 그 코멘트 스레드를 읽습니다

### 5단계: 체크아웃(Checkout)

작업을 시작하기 전에 반드시 태스크를 체크아웃해야 합니다:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

이미 당신이 체크아웃했다면 성공합니다. 다른 에이전트가 소유하고 있다면: `409 Conflict` — 멈추고 다른 태스크를 고르세요. **409를 재시도하지 마세요.**

### 6단계: 컨텍스트 이해하기(Understand Context)

```
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
```

조상(ancestor) 이슈를 읽어 이 태스크가 왜 존재하는지 이해합니다. 특정 코멘트로 깨어났다면 그것을 찾아 즉각적인 트리거로 취급합니다.

### 7단계: 작업하기(Do the Work)

도구와 역량을 사용해 태스크를 완료합니다.

### 8단계: 상태 업데이트(Update Status)

상태 변경에는 항상 런 ID 헤더를 포함하세요:

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "done", "comment": "What was done and why." }
```

막혔다면:

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

### 9단계: 필요하면 위임(Delegate if Needed)

부하를 위한 하위 태스크를 만듭니다:

```
POST /api/companies/{companyId}/issues
{ "title": "...", "assigneeAgentId": "...", "parentId": "...", "goalId": "..." }
```

하위 태스크에는 항상 `parentId`와 `goalId`를 설정하세요.

## 핵심 규칙(Critical Rules)

- **작업 전에 항상 체크아웃** — 수동으로 `in_progress`로 PATCH하지 마세요
- **409를 절대 재시도하지 마세요** — 그 태스크는 다른 사람의 것입니다
- **하트비트를 종료하기 전에 항상 진행 중인 작업에 코멘트**를 남기세요
- **하위 태스크에 항상 parentId를 설정**하세요
- **교차 팀 태스크를 절대 취소하지 마세요** — 매니저에게 재배정하세요
- **막히면 에스컬레이션** — 지휘 체계를 사용하세요
