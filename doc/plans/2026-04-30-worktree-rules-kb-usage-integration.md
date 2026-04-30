# Worktree Rules + Knowledge Base 사용 연결 단계별 계획

Date: 2026-04-30
Status: implementation baseline through Phase 3; next work is dogfood, rule-kind split design, UI surfacing, and soft enforcement
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

## 구현 기준선 — 2026-04-30 현재

### 완료된 연결

1. **Guidance/context injection**
   - `resolveMaintenanceGuidanceContext()`가 active Worktree Rules와 KB excerpt를 heartbeat context의 `paperclipMaintenanceGuidance`로 주입한다.
   - workflow step KB가 있으면 우선 사용하고, 없거나 보수팀 공통 guidance가 필요하면 agent-accessible KB fallback을 사용한다.
2. **Step input manifest / runtime brief 노출**
   - `buildStepInputManifest()`가 `maintenanceGuidance`와 `maintenanceDecision` 섹션을 만든다.
   - `buildPaperclipRuntimeBrief()`가 agent가 읽는 brief에 rules/KB/decision summary를 표시한다.
3. **Decision preflight**
   - `maintenanceDecisionService.evaluateIssue()`가 issue context를 기반으로 `recommendedNextAction`, `suggestedStatus`, `requiredInputs`, `warnings`, `handoffTarget`, `matchedRules`, `kbReferences`를 산출한다.
   - 이 결과는 heartbeat context의 `paperclipMaintenanceDecision`으로 들어간다.
4. **Audit baseline**
   - heartbeat에서 decision이 평가되면 `activity_log`에 `maintenance_decision_evaluated` action을 남긴다.
   - payload에는 issue/run/workflow/step 식별자, 추천 action/status, required inputs, warning, handoff target, matched rules, KB references가 포함된다.

### 아직 완료가 아닌 것

- Issue/status/comment/handoff route에서 decision과 실제 action의 불일치를 검사하지 않는다.
- Operator UI에서 applied rules, KB excerpts, decision, audit timeline을 명시적으로 보여주지 않는다.
- `worktree_rules` schema/API/UI에는 Execution Guard Rules와 Workflow Decision Rules가 아직 같은 shape로 섞여 있다.
- Hard enforcement는 의도적으로 하지 않았다. 현재는 **보여주기 + 판단 힌트 + 감사 기록** 단계다.

## Rule kind split 설계

### 왜 분리해야 하는가

현재 `worktree_rules`는 `severity`, `action`, `predicate`, `decisionMap`, `message` 중심의 공통 shape를 사용한다. 이 구조는 두 성격을 모두 담을 수는 있지만, 운영자가 무엇을 작성하고 agent/runtime이 어떻게 써야 하는지 모호하다.

1. **Execution Guard Rule**은 runtime/tool/file/command action을 대상으로 한다.
   - 목적: 위험한 실행을 warn/block한다.
   - 판단 시점: command/file/tool action 직전.
   - 실패 방식: warning, require override, block.
2. **Workflow Decision Rule**은 maintenance issue의 업무흐름 판단을 대상으로 한다.
   - 목적: missing input, affected system, incident, vendor handoff, evidence, recurrence prevention 같은 업무 판단을 안내한다.
   - 판단 시점: heartbeat/checkout/preflight와 issue action 직전.
   - 실패 방식: 추천 action, suggested status, audit, soft enforcement, 필요 시 require override.

사용자가 원하는 Worktree Rules의 중심은 2번이다. 따라서 schema/API/UI에서는 두 kind를 명시해야 한다.

### 제안 schema shape

공통 필드:

```ts
type WorktreeRuleBase = {
  id: string;
  companyId: string;
  kind: "execution_guard" | "workflow_decision";
  name: string;
  enabled: boolean;
  severity: "info" | "warn" | "high" | "critical";
  message: string;
  enforcementMode: "observe" | "warn" | "require_override" | "block";
  predicate: Record<string, unknown>;
  version: number;
};
```

Execution Guard 전용:

```ts
type ExecutionGuardRuleConfig = {
  target: "command" | "file" | "tool" | "api";
  actionPattern?: string;
  commandPattern?: string;
  filePattern?: string;
  toolNamePattern?: string;
  blockedOperations?: string[];
};
```

Workflow Decision 전용:

```ts
type WorkflowDecisionRuleConfig = {
  conditionSummary: string;
  requiredInputs?: string[];
  recommendedNextAction:
    | "request_missing_input"
    | "identify_affected_system"
    | "investigate"
    | "escalate_incident"
    | "vendor_handoff"
    | "repair"
    | "verify_and_close"
    | "record_recurrence";
  suggestedStatus?: "todo" | "in_progress" | "blocked" | "done";
  escalationTarget?: string;
  handoffTarget?: string;
  evidenceRequirements?: string[];
  recurrenceRequirements?: string[];
  promptGuidance: string;
};
```

### Migration 방향

1. Backward-compatible 컬럼부터 추가한다.
   - `kind text not null default 'execution_guard'`
   - `enforcement_mode text not null default 'warn'`
   - `config jsonb not null default '{}'`
2. 기존 보수팀 업무 판단 rule은 `kind='workflow_decision'`으로 backfill한다.
   - `action` 값이 `request_missing_input`, `identify_affected_system`, `vendor_handoff`, `escalate_incident`, `verify_and_close`, `record_recurrence` 계열이면 workflow decision으로 본다.
   - destructive/read-only/command/file/tool 관련 rule은 execution guard로 둔다.
3. API response는 구버전 필드(`action`, `decisionMap`)를 당분간 유지한다.
4. UI는 kind 선택에 따라 form section을 나눈다.

## Enforcement phases

### Phase 1 — Context/Guidance: 완료

- Agent에게 active rules와 KB excerpt를 보여준다.
- 목적은 “있는데 안씀” 상태를 깨는 것이다.
- 실패해도 action을 막지 않는다.

### Phase 2 — Decision Preflight: 완료

- Issue 기준으로 recommended next action과 suggested status를 구조화한다.
- Agent에게 missing input / handoff / incident / repair / verification 방향을 명시한다.

### Phase 3 — Audit Baseline: 부분 완료

- `maintenance_decision_evaluated`는 activity log에 남긴다.
- 아직 “rule injected”, “KB injected”, “action followed/overridden” 이벤트는 분리되어 있지 않다.

### Phase 4 — Dogfood / 실제 mission 검증: 다음 작업

검증할 실제 시나리오:

1. Missing input issue
   - affected system, symptom, time window, requester contact 중 일부가 빠진 issue를 agent에게 맡긴다.
   - 기대: agent가 바로 repair하지 않고 보완 요청 comment/status로 진행한다.
   - 확인: runtime brief `Required inputs`, `maintenance_decision_evaluated` audit.
2. Vendor handoff issue
   - 외부 장비/벤더 의존이 명시된 issue를 agent에게 맡긴다.
   - 기대: 자체 repair 전에 vendor handoff target과 필요한 evidence를 정리한다.
   - 확인: decision `vendor_handoff`, activity payload `handoffTarget`.
3. Verification/close issue
   - 조치가 끝난 것처럼 보이나 evidence가 부족한 issue를 맡긴다.
   - 기대: 완료 전에 evidence/recurrence prevention 기록을 요구한다.

### Phase 4 dogfood 결과 — 2026-04-30

검증 파일:

- `server/src/__tests__/maintenance-mission-dogfood.test.ts`

검증 방식:

- 실제 운영 DB나 provider adapter를 사용하지 않고, embedded Postgres + fake adapter로 heartbeat runtime path를 태웠다.
- 각 scenario는 mission-linked issue, active Worktree Rules, agent-accessible Maintenance SOP KB를 만든 뒤 heartbeat를 실행한다.
- fake adapter가 받은 context에서 다음을 확인한다.
  - `paperclipMaintenanceGuidance`
  - `paperclipMaintenanceDecision`
  - `paperclipStepInputManifest.inputs.maintenanceGuidance`
  - `paperclipStepInputManifest.inputs.maintenanceDecision`
  - `buildPaperclipRuntimeBrief(context)` 결과
  - `activity_log`의 `maintenance_decision_evaluated` payload

시나리오별 관찰:

1. Missing input
   - 입력: affected system, symptom, time window가 없는 maintenance issue.
   - runtime context decision: `recommendedNextAction=request_missing_input`, `suggestedStatus=blocked`, `requiredInputs=[affectedSystem, symptom, timeWindow]`.
   - brief에 agent가 보는 문구: `Maintenance decision: request_missing_input`, `Required inputs: affectedSystem, symptom, timeWindow`.
   - activity_log payload: 같은 action/status/requiredInputs와 KB reference를 기록한다.
   - soft enforcement 후보: 이 상태에서 `done` 또는 repair성 status/action으로 가면 mismatch audit.
2. Customer-impact outage
   - 입력: production/customer impact/outage와 결제 불가, 발생 시각, symptom이 명시된 issue.
   - runtime context decision: `recommendedNextAction=escalate_incident`, `suggestedStatus=in_progress`, `requiredInputs=[]`.
   - brief에 agent가 보는 문구: `Maintenance decision: escalate_incident`, `Required inputs: none`.
   - activity_log payload: incident escalation match와 KB reference를 기록한다.
   - soft enforcement 후보: incident escalation 추천인데 일반 close/done 처리하면 mismatch audit.
3. Vendor dependency
   - 입력: PG사/external API/vendor timeout이 명시된 issue.
   - runtime context decision: `recommendedNextAction=vendor_handoff`, `suggestedStatus=in_progress`, `handoffTarget=vendor`.
   - brief에 agent가 보는 문구: `Maintenance decision: vendor_handoff`, `Handoff target: vendor`.
   - activity_log payload: vendor handoff target과 matched rule, KB reference를 기록한다.
   - soft enforcement 후보: vendor handoff 추천인데 자체 완료하면 mismatch audit.
4. Done without evidence
   - 입력: affected system/symptom/time window는 있으나 evidence/verification 없이 `requestedStatus=done`이 들어온 issue.
   - runtime context decision: `recommendedNextAction=verify_and_close`, `suggestedStatus=in_review`, `warnings=[completion_evidence_missing]`.
   - brief에 agent가 보는 문구: `Maintenance decision: verify_and_close`, `Decision warnings: completion_evidence_missing`.
   - activity_log payload: warning과 verify-before-close matched rule, KB reference를 기록한다.
   - soft enforcement 후보: evidence/verification 없이 `done` 처리하면 mismatch 또는 require-override audit.

결론:

- 현재 baseline은 fake adapter runtime path에서 agent-visible input까지 의미 있게 도달한다.
- dogfood 결과상 다음 구현은 broad hard enforcement가 아니라 route-level soft enforcement audit가 적절하다.
- 우선 후보는 `maintenance_decision_action_mismatch`이며, missing input → done, vendor handoff → self-close, incident → normal close, evidence missing → done 시도를 관찰 대상으로 삼는다.

### Phase 5 — Observability / Soft Mismatch Audit: 다음 구현 후보

Issue action route에서 decision과 실제 action이 어긋날 수 있는 지점을 관찰 가능한 audit로 남긴다. 목적은 agent 판단을 RPA식으로 차단하는 것이 아니라, 인간 팀처럼 역할별 책임 판단과 설명 가능한 이탈을 추적하는 것이다. 처음부터 block하지 않는다.

후보 이벤트:

```ts
maintenance_decision_action_mismatch
maintenance_decision_override_recorded
maintenance_required_input_requested
maintenance_vendor_handoff_followed
```

초기 규칙:

- `recommendedNextAction=request_missing_input`인데 issue를 `done`으로 변경하면 mismatch audit.
- `requiredInputs`가 있는데 comment에 보완 요청 없이 repair/close하려 하면 mismatch audit.
- `recommendedNextAction=vendor_handoff`인데 자체 완료하면 mismatch audit.
- `recommendedNextAction=escalate_incident`인데 일반 issue close하면 mismatch audit.

처음에는 API 응답을 실패시키지 않고 audit만 남긴다. 이후 운영 로그를 보고 단순 block으로 승격하기보다, 먼저 `role/responsibility/authority`, `decision rationale`, `override reason` 모델을 설계한다. Hard block은 회사 정책상 절대 위반하면 안 되는 execution guard 또는 명백한 권한 초과에만 마지막 수단으로 검토한다.

### Phase 5 coverage 확인 결과 — 2026-04-30

목표는 `PATCH /api/issues/:id` 외 issue 상태/조치 변경 경로 중 soft mismatch audit 누락을 확인하고, 필요한 최소 hook만 붙이는 것이다.

확인한 entry point:

| Entry point | 분류 | 역할/책임 관점의 판단/조치 |
| --- | --- | --- |
| `PATCH /api/issues/:id` (`server/src/routes/issues.ts`) | already covered | status 변경 시 `auditMaintenanceActionMismatch()`가 `maintenance_decision_action_mismatch`를 기록한다. terminal status(`done`/`cancelled`/`closed`)만 helper에서 mismatch 평가된다. |
| `POST /api/issues/:id/checkout` → `issueService.checkout()` | not terminal status mutation | status를 `in_progress`로 바꾸는 claim/lock 경로다. terminal close가 아니므로 mismatch audit 대상에서 제외했다. SRB source sync는 mirror를 `in_progress`로만 동기화한다. |
| `POST /api/issues/:id/release` → `issueService.release()` | not terminal status mutation | status를 `todo`로 되돌리는 release 경로다. terminal close가 아니므로 mismatch audit 대상에서 제외했다. |
| `POST /api/issues/:id/comments` reopen path | not terminal status mutation | closed issue에 `reopen=true`가 있으면 status를 `todo`로 변경한다. close가 아니라 reopen이므로 mismatch audit 대상에서 제외했다. |
| `POST /api/issues/:id/comments` comment-only | not terminal status mutation | issue `updatedAt`과 comment만 변경한다. status close/done/cancelled를 동반하지 않는다. |
| issue document/work-product/read/inbox/archive/approval routes | not terminal status mutation | issue 상태를 변경하지 않는다. |
| `issueService.update()` 직접 호출 | covered via known API route or future candidate | 일반 API route는 `PATCH /api/issues/:id`에서 hook을 탄다. 서비스 자체는 범용 update라 hard coupling하지 않았다. 내부 direct caller는 별도 확인했다. |
| `createSrbPairSync().syncSourceStatus()` → mirror issue `issueSvc.update(pair.mirrorIssueId, { status: nextMirrorStatus })` | separate mutation path needing audit hook | source issue status를 mirror issue에 동기화하는 별도 service mutation path다. source route audit와 별개로 mirror issue terminal close가 발생할 수 있으므로 `logMaintenanceDecisionActionMismatch()`를 재사용해 `attemptedAction=srb.mirror_status_sync` audit hook을 추가했다. 이 hook은 mirror 담당 role의 vendor handoff / incident / missing input 책임 판단이 rule/KB와 어긋날 수 있는 지점을 관찰 가능하게 하는 용도이며, 실패해도 sync는 차단하지 않고 warn만 남긴다. |
| `heartbeat.ts` auto-block on run failure/timeout | not terminal status mutation | 자동 `blocked` 전환이다. terminal close가 아니므로 mismatch audit 대상에서 제외했다. |
| workflow/routine `syncRunStatusForIssue()` | unclear / future candidate | 현재 확인 범위에서는 issue status를 직접 terminal로 바꾸는 경로가 아니라 run/status aggregate sync에 가깝다. 향후 workflow plugin이 issue terminal status를 직접 업데이트하는 action route가 생기면 같은 helper hook 후보다. |

추가 테스트:

- `server/src/__tests__/issues-service.test.ts`
  - `audits terminal SRB mirror status sync mismatches without blocking the mirror update`
  - `mirror_source_status` pair에서 source `done` 동기화가 mirror issue를 `done`으로 바꾸되, mirror issue가 vendor handoff decision이면 `maintenance_decision_action_mismatch` audit을 남기는지 검증한다.

제외한 것:

- schema/API/UI/rule kind split 변경 없음.
- hard block 없음.
- RPA식 세부 절차화 없음. agent의 상황 판단은 유지하고, 이탈 가능성은 설명 가능한 audit로 관찰한다.
- override reason 요구 없음. 다음 설계 후보는 단순 block보다 role/responsibility/authority + decision rationale/override reason이다.
- comment-only route를 terminal close처럼 확대 해석하지 않음.

### Role / Responsibility / Authority 설계 초안 — 2026-04-30

목표는 RPA식 `조건 → 무조건 행동`이 아니라, 인간 팀처럼 역할과 책임을 가진 agent에게 rule/workflow/KB 하네스를 제공하는 것이다. Rule/KB/workflow는 agent 판단을 대체하는 명령이 아니라 판단을 설명 가능하게 만드는 근거이며, hard enforcement는 마지막 수단이다.

#### Maintenance context role 예시

| Role | responsibility: 책임지는 결과/상태 | authority: 단독으로 할 수 있는 조치 | needs_collaboration: 넘겨야 하는 경우 | hard_stop_candidates |
| --- | --- | --- | --- | --- |
| `customer_response` | 요청자/고객에게 현재 상태, 필요한 추가 정보, 완료 근거를 이해 가능하게 전달한다. 누락 입력(symptom/time window/contact/repro)을 확인한다. | 보완 질문, 상태 공유, 확인 요청, evidence 요청 comment 작성. | 비용/계약/법무 표현, 벤더 공식 발송, 장애 보상/책임 인정, 원인 단정이 필요한 경우 `approver`/`operator`와 협업. | 외부 확정 발송, 법적 책임 인정, 보상/환불 약속. |
| `maintenance_triage` | issue의 affected system, severity, customer impact, incident 여부, 다음 담당 role을 판단한다. | `todo`/`in_progress`/`blocked`/`in_review` 수준의 상태 제안·변경, 필요한 입력/KB/로그 요청, 담당 role 추천. | vendor 의존은 `vendor_handoff`, 외부/비용/권한 초과는 `approver`, 고객 영향 큰 장애는 `operator` 또는 incident owner와 협업. | high-impact issue를 evidence/rationale 없이 `done` 처리, incident를 일반 issue처럼 close. |
| `vendor_handoff` | 벤더/외부 장비/API/PG 의존 이슈의 재현 자료, 로그, 문의 문맥, handoff packet을 준비한다. | 벤더 문의 초안 작성, 내부 handoff note 작성, 필요한 evidence 목록화. | 실제 벤더 발송, 계약/SLA/비용/책임 표현, 고객-facing 약속은 `approver`/`operator` 확인 필요. | 외부 발송, 비용 발생 요청, SLA penalty 인정, 계약 해석. |
| `mirror_sync` / `srb_sync` | source issue 상태와 mirror issue 상태를 동기화하면서, mirror 쪽 role 책임 판단이 누락되지 않도록 관찰한다. | source status를 mirror status로 반영, alignment observation audit 기록, sync 실패 warn. | mirror issue가 vendor/incident/missing-input 책임을 요구하는데 terminal close로 동기화되는 경우 해당 담당 role 또는 `operator`에게 rationale 확인 필요. | cross-company irreversible close, 외부 발송을 동반한 sync, 비용/계약/법무 상태 동기화. |
| `approver` / `operator` | 예외 승인, high-risk action 승인, 책임자 지정, override reason 품질을 관리한다. | override reason 승인, high-risk action 승인/반려, hard-stop 예외 승인, 담당 role 재배정. | 법무/보안/재무 전문 판단이 필요한 경우 해당 사람/role과 협업. | irreversible, external, cost, contract/legal/compliance, production-destructive action. |

#### Boundary 원칙

- `responsibility`: role이 반드시 확인하거나 설명해야 하는 결과. 예: `maintenance_triage`는 affected system/severity/next role을 설명해야 한다.
- `authority`: role이 단독으로 실행·확정할 수 있는 범위. 예: `customer_response`는 보완 질문은 가능하지만 비용/계약 약속은 불가하다.
- `needs_collaboration`: 다른 role/사람에게 넘기거나 rationale을 받아야 하는 상황. 이는 block이 아니라 협업 요청 또는 observation으로 시작한다.
- `hard_stop_candidates`: irreversible/external/cost/legal/production-destructive처럼 정책상 극소수만 후보가 된다.
- Worktree Rule은 세부 절차표가 아니라 role별 판단 기준이고, KB는 시스템별 근거/맥락이다. KB 부재는 즉시 block보다 “근거 부족” observation과 보완 요청으로 남긴다.

#### Decision alignment observation event shape 후보

기존 `maintenance_decision_action_mismatch`는 바로 폐기하지 않는다. 상위 개념을 `decision_alignment_observation` 또는 `maintenance_decision_observed`로 잡고, 기존 event는 `alignment=diverged_*`의 초기 구현으로 해석한다.

```ts
type MaintenanceDecisionObserved = {
  event:
    | "maintenance_decision_observed"
    | "maintenance_decision_alignment_observed"
    | "maintenance_decision_action_mismatch"; // backward-compatible legacy event
  issueId: string;
  actor: {
    type: "agent" | "user" | "system";
    id: string;
    role?: "customer_response" | "maintenance_triage" | "vendor_handoff" | "mirror_sync" | "srb_sync" | "approver" | "operator" | string;
  };
  responsibility?: string | null;
  attemptedAction: string;
  attemptedStatus?: string | null;
  expectedAction?: string | null;
  expectedStatus?: string | null;
  alignment: "aligned" | "diverged_with_rationale" | "diverged_without_rationale" | "insufficient_context";
  severity: "observe" | "needs_reason" | "needs_approval";
  rationale?: string | null;
  overrideReason?: string | null;
  authorityBoundary?: {
    currentRole?: string | null;
    requiredRole?: string | null;
    withinAuthority: boolean;
    needsCollaborationWith?: string[];
    reason?: string | null;
  };
  observationReasons: string[];
  ruleRefs: Array<{ id: string; name: string; action?: string | null }>;
  kbRefs: Array<{ id: string; name: string; source?: string | null }>;
  workflowRefs?: Array<{ workflowId?: string; stepId?: string; name?: string }>;
  hardStopCandidate?: boolean;
};
```

의미:

- 사용자-facing 용어는 `violation`이 아니라 `decision alignment observation`으로 둔다.
- `mismatchReasons`는 장기적으로 `observationReasons`로 확장한다.
- `recommendedNextAction`은 상위 payload에서 `expectedAction`으로 일반화할 수 있다.
- route hook은 mutation을 막지 않고, 어떤 role의 어떤 responsibility 판단이 rule/KB/workflow와 다르게 진행됐는지, 그리고 rationale/override reason이 있었는지를 남긴다.
- `severity=observe`: 관찰만.
- `severity=needs_reason`: 진행은 허용하되 rationale/override reason이 필요.
- `severity=needs_approval`: approver/operator collaboration이 필요. 그래도 hard stop과는 구분한다.

#### Hard stop 후보 제한

Hard stop은 극소수로 제한한다.

- irreversible action: 데이터 삭제, 영구 상태 변경, 되돌리기 어려운 운영 조치
- external action: 고객/벤더/외부 채널로 실제 발송되는 확정 메시지, 법적/계약상 표현
- cost action: 결제, 구매, 유료 리소스 증설, SLA/보상 인정
- contract/legal/compliance action: 계약 해석, 개인정보, 보안 사고, 법적 책임 인정, 규제 대응
- production-destructive action: 운영 DB/인프라에 직접 파괴적 영향이 있는 조치

그 외 업무흐름 divergence는 block보다 rationale/override reason을 요구하거나, `approver`/`operator`에게 escalation하는 방식이 Papercompany 목적에 맞다.

#### Implementation sequencing 후보

- Phase A — prompt/runtime brief에 role context 추가
  - agent에게 현재 role, responsibility, authority boundary, collaboration 필요 조건을 brief에 제공한다.
  - rule/KB는 “해야 할 명령”이 아니라 role 판단의 근거로 표현한다.
- Phase B — audit event에 rationale/role 필드 확장
  - 기존 `maintenance_decision_action_mismatch` details에 `role`, `responsibility`, `expectedAction`, `rationale`, `overrideReason`, `authorityBoundary`, `severity`를 backward-compatible하게 추가한다.
  - 이후 상위 event명 `maintenance_decision_alignment_observed`로 확장할지 결정한다.
- Phase C — UI surfacing
  - issue/workflow 화면에 current role, expected action, divergence reason, rationale/override reason, ruleRefs/kbRefs를 보여준다.
  - operator가 “차단”보다 “책임 있는 예외/협업 필요”를 판단할 수 있게 한다.
- Phase D — optional approval/hard stop only for high-risk actions
  - irreversible/external/cost/contract/legal/production-destructive action에만 approval 또는 hard stop을 검토한다.
  - 일반 workflow divergence는 observation + rationale + collaboration으로 유지한다.

### Phase 6 — UI Surfacing: 다음 구현 후보

Operator가 issue/workflow 화면에서 다음을 볼 수 있어야 한다.

- Applied Worktree Rules
- Injected KB references/excerpts
- Latest Maintenance Decision
- Required inputs
- Suggested status/action
- Handoff target
- Audit timeline: evaluated / followed / overridden / mismatched

### Phase 7 — Authority Boundary / Hard Enforcement: 마지막

회사 정책상 절대 어기면 안 되는 execution guard 또는 명백한 authority boundary만 block한다. Workflow Decision Rule은 기본적으로 인간 팀의 업무 규정집처럼 role/responsibility/accountability를 제공하고, agent가 상황에 맞게 판단한 근거와 예외를 남기게 한다.

- destructive execution guard
- 명백한 missing required input 상태에서 done 처리: 우선 rationale/override reason 요구 후보, 즉시 block은 아님
- vendor handoff required인데 자체 완료: 담당 role의 권한/책임 범위와 decision rationale 확인 후보
- incident escalation required인데 일반 close: incident owner 책임과 escalation authority 확인 후보

Hard enforcement 전에는 반드시 role/responsibility/authority 모델, UI override/exception 흐름, operator audit가 있어야 한다.

## 완료 기준

최소 범위 완료 기준:

1. active Worktree Rule이 agent runtime brief에 표시된다. — 완료
2. 접근 가능한 KB가 issue query 기준으로 retrieval되어 runtime brief에 excerpt로 표시된다. — 완료
3. 테스트가 “rule/KB가 prompt에 들어간다”를 검증한다. — 완료
4. 기존 `pnpm -r typecheck`, `pnpm test:run`이 통과한다. — 완료. 단, `workspace-runtime.test.ts`는 환경에 따라 readiness timeout이 있어 개별 재실행 확인이 필요하다.

최대 범위 완료 기준:

1. decision preflight가 recommended action을 구조화해서 산출한다. — 완료
2. audit log에 rule/KB 사용과 override 여부가 남는다. — 부분 완료: decision evaluated는 남고, followed/override/mismatch는 아직 남지 않는다.
3. UI에서 operator가 matched rules/KB/recommendation을 확인할 수 있다. — 미완료
4. soft/hard enforcement mode가 정책에 따라 동작한다. — 미완료
