아래 Paperclip Workflow Engine Plugin의 코드 리뷰 결과를 반영하여 수정하세요.

프로젝트 경로: /Users/kwak/Projects/paperclip/paperclip-addon/plugins/workflow-engine/

## Critical 수정 3건

### 1. activateBacklogStep()에 이슈 생성 추가
파일: src/worker.ts의 activateBacklogStep() 함수

현재: step을 todo로 전환하고 agent를 invoke만 함
필요: ctx.issues.create()로 Paperclip 이슈를 생성하고, 생성된 issueId를 stepRun에 저장

```typescript
async function activateBacklogStep(...) {
  // 1. Paperclip 이슈 생성
  const issue = await ctx.issues.create(companyId, {
    title: `[${workflowName}] ${stepDef.title}`,
    description: getStepDescription(stepDef) ?? `Workflow step: ${stepDef.id}`,
    assigneeAgentId: resolvedAgent.agentId,
    status: "todo",
  });
  
  // 2. stepRun에 issueId 저장
  await updateStepRun(ctx, stepRunRecord.id, {
    status: STEP_STATUSES.todo,
    issueId: issue.id,
    startedAt: new Date().toISOString(),
  });
  
  // 3. agent invoke (이슈 할당으로 자동 wakeup되므로 선택적)
}
```

### 2. startWorkflow() 함수 추가
파일: src/worker.ts에 새 함수 추가 + data handler로 등록

workflow를 시작하는 진입점:
- WorkflowRun entity 생성 (status: "running")
- 모든 step에 대해 WorkflowStepRun entity 생성 (status: "backlog")
- agent name → agentId resolve (ctx.agents.list + name 매칭)
- dependsOn이 빈 step들 → activateBacklogStep() 호출 (이슈 생성 + todo + wakeup)
- parent issue 생성 (optional, workflow 전체를 묶는 이슈)

data handler로 등록하여 UI나 webhook에서 호출 가능하게:
```typescript
ctx.data.handle("start-workflow", async (params) => {
  // params: { workflowId, companyId }
  return startWorkflow(ctx, params.workflowId, params.companyId);
});
```

### 3. ctx.entities.get(id) 대신 안전한 조회 패턴
파일: src/workflow-store.ts

getEntityByType() 함수에서 ctx.entities.get(id) 후 entityType 체크하는 방식 대신,
가능하면 ctx.entities.list({ entityType, filters }) 패턴 사용.
ctx.entities.list가 externalId 필터를 지원하지 않으면 현재 방식 유지하되 주석으로 한계 명시.

## Important 수정 4건

### 4. 중복 헬퍼 → shared utils 추출
새 파일: src/workflow-utils.ts 생성

worker.ts와 reconciler.ts에 중복된 함수들을 추출:
- toWorkflowRunRecord, toWorkflowStepRunRecord, toWorkflowDefinitionRecord
- findStepDefinition
- getStepAgentName / getStepAgentNameHint
- TERMINAL_STEP_STATUSES

양쪽 파일에서 import로 교체.

### 5. parentId filler 구현
파일: src/worker.ts의 setup()에 issue.created 이벤트 핸들러 추가

```typescript
ctx.events.on("issue.created", async (event) => {
  // 이슈에 parentId가 없고 assigneeAgentId가 있으면
  // agent metadata에서 defaultParentIssueId 읽기
  // ctx.issues.update(issueId, { parentId }) 호출
});
```

agent metadata 접근: ctx.agents.get(agentId, companyId) → metadata.defaultParentIssueId

### 6. Agent Sessions 연동
파일: src/worker.ts의 invokeAgentForStep() 수정

step definition에 sessionMode 필드 확인:
- "fresh" (기본): ctx.agents.invoke (현재 동작)
- "reuse": stepRun에 이전 sessionId가 있으면 ctx.agents.sessions.sendMessage, 없으면 sessions.create

### 7. 타입 캐스팅 정리
파일: src/workflow-store.ts

toTypedRecord<T>() 함수에서 data 필드를 런타임 검증하는 guard 추가:
```typescript
function toTypedRecord<T>(record: PluginEntityRecord, entityType: string): TypedEntityRecord<T> {
  if (record.entityType !== entityType) {
    throw new Error(`Expected entity type "${entityType}", got "${record.entityType}"`);
  }
  return record as TypedEntityRecord<T>;
}
```

## 규칙
- Company ID, Agent ID 등 하드코딩 절대 금지. name 기반 resolve.
- ctx.entities 사용 (ctx.state 아님)
- 이벤트 핸들러는 멱등하게 (idempotency key 체크)
- 기존 코드 구조와 스타일 유지
