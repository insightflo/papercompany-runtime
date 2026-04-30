# Worktree Rules + Knowledge Base 사용 연결 단계별 계획

Date: 2026-04-30
Status: draft plan
Scope: Papercompany maintenance/team workflow decision path

## 목표

현재 Worktree Rules와 Knowledge Base는 저장/조회/일부 workflow step 계약에는 존재하지만, 일반 보수팀 agent가 이슈를 처리할 때 항상 업무 판단에 쓰인다고 보기 어렵다.

목표는 다음 두 자료를 agent 실행 경로에 실제로 연결하는 것이다.

1. **Worktree Rules**: 보수팀 업무흐름 판단 규정집
   - affected system 식별
   - 누락 정보 보완 요청
   - incident 승격
   - vendor handoff
   - evidence/verification
   - recurrence prevention
2. **Knowledge Base**: 시스템별·업무별 구체 지식
   - 해당 시스템에서 봐야 할 로그/API/문서
   - 운영 절차
   - 고객/벤더/내부 핸드오프 기준

## 현재 확인한 기준점

- Worktree Rules CRUD/API/UI와 제한적 runtime harness는 존재한다.
- 현재 harness는 `tool/action/severity` 중심이라 업무 판단 규칙을 실행하거나 추천하지 않는다.
- `resolveWorkflowStepKnowledgeContext()`는 workflow step의 `knowledgeBaseIds`에 묶인 KB만 retrieval해서 `paperclipWorkflowStepKnowledgeContext`로 넣는다.
- `buildStepInputManifest()`와 `buildPaperclipRuntimeBrief()`는 KB의 존재/이름 정도는 요약하지만, 실제 KB content와 Worktree Rules decision output을 강하게 prompt에 넣지는 않는다.
- 따라서 현재 상태는 “구성은 있는데, 일반 보수팀 업무 판단에 끈끈하게 쓰이지 않을 수 있음”이다.

## 설계 원칙

1. **Execution Guard Rules와 Workflow Decision Rules를 분리한다.**
   - Execution Guard: command/file/tool runtime guardrail
   - Workflow Decision: 이슈 업무 처리 판단 규정
2. **최소 범위부터 시작한다.**
   - 처음에는 prompt/context injection + 테스트로 “있는데 안씀”을 깨는 데 집중한다.
   - 강제 enforcement는 나중 단계로 둔다.
3. **KB는 전체 덤프가 아니라 관련 근거로 붙인다.**
   - workflow step KB가 있으면 우선 사용
   - 없으면 agent 접근 가능한 KB에서 이슈 query로 retrieval
   - token budget과 source를 명확히 남김
4. **agent에게 애매한 판단을 떠넘기되, 규정과 근거를 명시한다.**
   - 코드에 주제성 분류를 하드코딩하지 않는다.
   - 구조적 정보: 회사, 이슈, agent grant, rule kind, enabled 상태만 코드가 결정한다.
5. **감사 가능해야 한다.**
   - 어느 rule/KB가 prompt에 들어갔는지
   - 추천 action이 무엇이었는지
   - agent/operator가 따랐는지/무시했는지 나중에 볼 수 있게 한다.

## 단계 0 — 현상 고정 테스트/스냅샷

### 목적
현재 “있는데 안씀” 상태를 회귀 테스트로 고정한다.

### 작업
- Worktree Rules/KB 관련 현재 테스트 위치 확인
  - `server/src/__tests__/p4-worktree.test.ts`
  - `server/src/services/heartbeat.ts` 주변 테스트
  - `server/src/services/step-input-manifest.ts`
  - `packages/adapter-utils/src/runtime-brief.ts`
- 다음 실패 기대 테스트를 먼저 작성한다.
  - active workflow decision rule이 있을 때 runtime context/brief에 rule summary가 포함되어야 한다.
  - agent 접근 가능 KB가 있을 때, workflow step KB가 아니어도 maintenance issue query로 retrieval된 KB summary가 포함되어야 한다.

### 산출물
- 실패하는 테스트 1~2개
- 구현 전후 차이가 명확한 fixture

### 검증
- `pnpm test:run -- <관련 테스트>` 또는 repo 테스트 명령으로 RED 확인

## 단계 1 — 최소 연결: Runtime Context/Brief에 Worktree Rules + KB 넣기

### 목적
agent가 실행될 때 prompt에서 Worktree Rules와 KB 내용을 보게 만든다.
강제/자동 action은 아직 하지 않는다.

### 작업
1. `server/src/services/heartbeat.ts`에 context resolver 추가
   - 예: `resolveMaintenanceGuidanceContext()`
   - 입력: `db`, `companyId`, `agentId`, `issueContext`, `taskKey`, `note`
   - 출력 예:
     ```ts
     context.paperclipMaintenanceGuidance = {
       version: 1,
       rules: [{ id, name, kind, severity, action, summary, promptText }],
       knowledge: [{ id, name, type, source, tokenCount, content }],
       query: "..."
     }
     ```
2. Worktree Rules retrieval
   - company scoped + enabled
   - `workflow_decision` 계열만 우선 포함
   - 너무 많으면 우선순위: severity/action/name 기준으로 상한 10개
3. KB retrieval
   - workflow step `knowledgeBaseIds`가 있으면 기존 path 재사용
   - 없거나 보수팀 공통 guidance가 필요하면 `knowledgeService.listAccessible()`에서 agent 접근 가능 KB를 가져와 issue query로 retrieval
   - max token budget 제한
4. `server/src/services/step-input-manifest.ts` 확장
   - `inputs.maintenanceGuidance.available/count`
   - `inputs.maintenanceGuidance.ruleCount/knowledgeCount`
5. `packages/adapter-utils/src/runtime-brief.ts` 확장
   - rules: 이름/action/짧은 prompt
   - KB: source/title/content excerpt
   - agent에게 “먼저 rules로 처리 방향을 판단하고, KB로 시스템별 확인 지점을 찾으라”고 명시

### 산출물
- agent prompt에 Worktree Rules + KB가 보이는 최소 구현
- runtime brief 테스트

### 검증
- `pnpm -r typecheck`
- 관련 unit test
- 수동으로 heartbeat context/prompt에 `paperclipMaintenanceGuidance` 존재 확인

## 단계 2 — Decision Preflight 서비스 추가

### 목적
agent가 이슈를 잡기 전/처리 시작 시 “다음에 무엇을 해야 하는지” 구조화된 추천을 받게 한다.

### 작업
1. 신규 서비스
   - `server/src/services/maintenance/decision-service.ts`
2. API/내부 함수 shape
   ```ts
   evaluateIssue({ db, companyId, agentId, issue, workspace, note }): Promise<{
     matchedRules: Array<{ id, name, action, severity, reason }>;
     recommendedNextAction: "request_missing_input" | "identify_affected_system" | "investigate" | "escalate_incident" | "vendor_handoff" | "repair" | "verify_and_close" | "record_recurrence";
     requiredInputs: string[];
     suggestedStatus: "todo" | "in_progress" | "blocked" | "done" | null;
     handoffTarget: string | null;
     promptBlock: string;
     kbReferences: Array<{ id, name, source, excerpt }>;
   }>
   ```
3. rule predicate는 과하게 하드코딩하지 않음
   - 구조적 predicate만 평가: issue field presence, severity, affectedSystem 존재 여부, customerImpact flag 등
   - 주제성 판단은 promptBlock에 rule을 제공하고 agent 판단에 맡김
4. heartbeat context에 preflight 결과 포함
   - `paperclipMaintenanceDecision`
5. issue checkout 혹은 heartbeat 시작 로그에 decision summary 기록

### 산출물
- decision service
- 이슈 누락 정보 케이스 테스트
- promptBlock 생성 테스트

### 검증
- “affected system 없음 + symptom/timeWindow 누락” fixture에서 `request_missing_input`, `blocked`, requiredInputs 산출
- 고객 영향 큰 fixture에서 `escalate_incident` 추천

## 단계 3 — Audit Logging 연결

### 목적
“규칙이 prompt에 있었다”를 넘어 “규칙이 쓰였는지”를 추적한다.

### 작업
1. `worktree_audit_log` 사용 지점 추가
   - decision preflight evaluated
   - rule injected into prompt
   - KB retrieved/injected
   - recommended action followed/overridden
2. 최소 route/service hook
   - issue status change
   - issue comment creation
   - handoff/incident 관련 mutation이 있으면 해당 route
3. audit payload 예
   ```json
   {
     "event": "maintenance_decision_evaluated",
     "issueId": "...",
     "matchedRuleIds": ["..."],
     "recommendedNextAction": "request_missing_input",
     "kbIds": ["..."],
     "actor": { "type": "agent", "id": "..." }
   }
   ```

### 산출물
- audit insert helper
- audit 조회 테스트 또는 DB row 생성 테스트

### 검증
- heartbeat/decision test에서 audit row 생성 확인
- 기존 p4-worktree 테스트 통과

## 단계 4 — UI/Operator 가시화

### 목적
운영자가 agent가 어떤 rule/KB를 보고 판단하는지 확인할 수 있게 한다.

### 작업
- Issue detail/Worktree Rules page 중 최소 한 곳에 표시
  - matched rules
  - recommended next action
  - missing required inputs
  - KB references
- “따름/무시/수동 override”를 activity/audit로 남김

### 산출물
- UI 표시
- API response 확장 또는 별도 endpoint

### 검증
- 브라우저 QA: 누락 정보 이슈에서 보완 요청 recommendation 표시

## 단계 5 — Soft Enforcement

### 목적
명백한 업무흐름 위반을 막지는 않되, 강한 경고와 override reason을 요구한다.

### 작업
- `request_missing_input` 추천인데 done/repair로 바로 가려는 경우 경고
- `escalate_incident` 추천인데 일반 처리로 닫으려는 경우 경고
- override reason 필드 요구
- route-level audit 남김

### 산출물
- route/service validation warning
- override audit

### 검증
- API 테스트: override reason 없으면 422 또는 warning response
- override reason 있으면 통과 + audit

## 단계 6 — Hard Enforcement / 정책화

### 목적
회사 정책상 절대 어기면 안 되는 규칙만 강제한다.

### 작업
- rule에 `enforcementMode: observe | warn | require_override | block` 같은 개념 추가 검토
- destructive/고위험 업무 action만 block 가능
- business decision은 대부분 `warn` 또는 `require_override` 유지

### 산출물
- schema/API/UI 확장 필요 가능성
- migration 필요 가능성

### 검증
- block rule 테스트
- 기존 Execution Guard Rules와 충돌 없음 확인

## 권장 실행 순서

1. **단계 0 + 단계 1**을 먼저 구현한다.
   - 가장 작고 효과가 큼.
   - “있는데 안씀” 문제를 prompt/context 수준에서 바로 해소.
2. 이후 실제 동작 품질을 보면서 **단계 2**로 decision preflight를 추가한다.
3. 운영 추적이 필요해지면 **단계 3** audit을 붙인다.
4. UI/강제는 마지막에 한다.

## 첫 PR/커밋 최소 범위 제안

### 포함
- `paperclipMaintenanceGuidance` context resolver
- active workflow decision rules 요약 주입
- agent-accessible KB retrieval fallback
- step input manifest + runtime brief 표시
- unit test 2~3개

### 제외
- DB schema migration
- UI 변경
- hard enforcement
- issue route validation 변경

## 완료 기준

최소 범위 완료 기준:

1. active Worktree Rule이 agent runtime brief에 표시된다.
2. 접근 가능한 KB가 issue query 기준으로 retrieval되어 runtime brief에 excerpt로 표시된다.
3. 테스트가 “rule/KB가 prompt에 들어간다”를 검증한다.
4. 기존 `pnpm -r typecheck`, `pnpm test:run`이 통과한다.

최대 범위 완료 기준:

1. decision preflight가 recommended action을 구조화해서 산출한다.
2. audit log에 rule/KB 사용과 override 여부가 남는다.
3. UI에서 operator가 matched rules/KB/recommendation을 확인할 수 있다.
4. soft/hard enforcement mode가 정책에 따라 동작한다.
