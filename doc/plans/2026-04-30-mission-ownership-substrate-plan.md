# Mission Ownership Substrate 설계 계획

Date: 2026-04-30
Status: M0 docs/spike only
Scope: Papercompany mission owner / main executor structural substrate

## 1. 목표와 비목표

### 목표

`main_executor` / `mission_owner`를 단순 표시용 담당자나 prompt-only 책임자에서, mission outcome을 실제로 소유하는 구조로 발전시킨다.

Mission owner는 인간 팀의 책임자처럼 다음을 수행해야 한다.

- mission planning: workflow, execution/worktree rules, KB를 종합해 실행 계획을 구성한다.
- delegation: 적절한 role/agent에게 책임을 배분한다.
- progress supervision: step, issue, workflow, heartbeat 상태를 읽고 stale/block/failure를 감지한다.
- failure diagnosis: 실패 원인을 분류하고 근거를 남긴다.
- recovery/replan: 우회, 재시도, 역할 재배치, 추가 정보 요청, escalation을 결정한다.
- completion/impossible report: 완료 근거 또는 완료 불가 근거와 필요한 결정을 보고한다.

핵심은 Hermes가 memory/tool/skill/harness를 실제로 사용하듯, Papercompany mission owner도 plan/delegate/supervise/diagnose/recover/report에 사용할 persistent objects, events, loops를 갖는 것이다.

### 비목표

이번 문서는 설계/계획만 다룬다.

- 코드 구현 없음
- DB migration/schema 변경 없음
- API/UI 변경 없음
- hard enforcement 없음
- RPA식 `condition -> action` 절차표 없음
- Phase A `roleContext` 구현 변경 없음
- Phase B audit event rationale/role field 확장으로 새지 않음

## 2. 설계 원칙

1. **Mission-level accountability, not RPA.**
   - 구조적 객체는 agent 판단을 대체하지 않는다.
   - mission owner가 판단하고 설명할 수 있도록 작전판/위임장/감독 루프/복구 기록을 제공한다.
2. **Persistent enough to resume.**
   - session이 바뀌어도 mission plan, delegation, diagnosis, recovery history를 복원할 수 있어야 한다.
3. **Evidence before closure.**
   - 완료는 결과물/검증/issue/workflow 상태 근거와 연결되어야 한다.
   - 완료 불가는 시도한 복구와 남은 결정사항을 분리해 보고해야 한다.
4. **Role substrate와 연결하되 고정 enum은 피한다.**
   - `customer_response`, `maintenance_triage`, `vendor_handoff`, `srb_sync`, `approver/operator` 같은 role vocabulary는 metadata/string 수준으로 시작한다.
5. **Confirmed vs proposed를 구분한다.**
   - 현재 schema/service로 재사용 가능한 것은 confirmed로 기록한다.
   - 새 persistent model이 필요하면 proposed로만 둔다.

## 3. Substrate 객체 후보

### A. `mission_plan` artifact

Mission owner가 보는 현재 작전판이다. workflow, rules, KB, assumptions, required inputs를 종합한 plan revision을 저장한다.

#### 필드 초안

```ts
type MissionPlanArtifact = {
  id: string;
  companyId: string;
  missionId: string;
  revision: number;
  status: "draft" | "active" | "replanned" | "completed" | "superseded";
  ownerAgentId: string;
  missionGoal: string;
  workflowRefs: Array<{ workflowId: string; workflowRunId?: string | null; name?: string | null }>;
  ruleRefs: Array<{ id: string; name: string; action?: string | null; source: "worktree_rule" | "execution_rule" }>;
  kbRefs: Array<{ id: string; name: string; reason?: string | null }>;
  assumptions: string[];
  requiredInputs: Array<{ key: string; status: "missing" | "requested" | "received"; source?: string | null }>;
  successCriteria: Array<{ description: string; evidenceRequired?: string | null }>;
  risks: Array<{ description: string; severity: "observe" | "needs_reason" | "needs_approval" }>;
  steps: Array<{
    id: string;
    title: string;
    intendedRole?: string | null;
    assignedAgentId?: string | null;
    issueId?: string | null;
    workflowStepId?: string | null;
    expectedOutput?: string | null;
    status: "planned" | "delegated" | "running" | "blocked" | "done" | "cancelled";
  }>;
  createdAt: string;
  updatedAt: string;
};
```

#### 사용 방식

- Mission 생성 또는 workflow mission materialization 시 initial plan 생성 후보.
- Mission owner heartbeat/runtime brief에 최신 active plan revision summary를 주입 후보.
- Replan 시 새 revision을 생성하고 이전 revision을 superseded로 둔다.

### B. `delegation_record`

Mission owner가 누구에게 어떤 responsibility를 맡겼는지 남기는 위임장이다.

#### 필드 초안

```ts
type DelegationRecord = {
  id: string;
  companyId: string;
  missionId: string;
  planArtifactId?: string | null;
  planStepId?: string | null;
  assignedRole: string;
  assignedAgentId?: string | null;
  assignedIssueId?: string | null;
  responsibility: string;
  expectedOutput: string;
  handoffContext: string;
  state: "assigned" | "accepted" | "running" | "blocked" | "stale" | "completed" | "cancelled";
  dueAt?: string | null;
  staleAfter?: string | null;
  blockedReason?: string | null;
  resultLink?: { type: "issue" | "workflow_step" | "artifact" | "activity"; id: string } | null;
  createdAt: string;
  updatedAt: string;
};
```

#### 사용 방식

- `mission_agents`는 참여자와 coarse role을 나타내고, `delegation_record`는 특정 responsibility 단위의 위임을 나타낸다.
- issue를 만들거나 workflow step에 agent를 배정할 때 delegation record를 연결 후보.
- stale/block state는 supervision loop의 입력이 된다.

### C. supervision/progress loop

Mission owner가 주기적으로 mission state를 읽고 다음 action을 판단하는 루프다. 이는 강제 workflow가 아니라 상황판 refresh + 판단 cadence다.

#### 읽는 state sources

- mission row: status, ownerAgentId, startedAt/completedAt/updatedAt
- mission agents: owner/executor/reviewer/observer 참여자
- mission sessions: active adapter sessions, lastActiveAt, runCount
- workflow runs / step runs: status, startedAt/completedAt, linked issue
- issues: missionId, status, assignee, originKind, executionRunId, comments/activity
- heartbeat/activity events: recent runs, failures, audits, comments
- proposed artifacts: active mission_plan, delegation_records, failure_diagnosis, recovery/replan history

#### detection 후보

- stale: delegation or issue가 일정 시간 update/comment/run 없이 멈춤
- blocked: issue/delegation state가 blocked이거나 required input missing
- failed: workflow step failed, heartbeat run failed, tool/adapter failure
- drift: plan step과 실제 issue/workflow 상태 불일치
- unowned work: missionId는 있으나 delegation/assignee/role이 없는 open issue
- completion gap: 모든 작업이 done처럼 보이나 success criteria evidence가 부족

#### cadence 후보

- on mission create: initial plan check
- on workflow step status change: plan/delegation reconciliation
- on issue status/comment change: delegation/progress update
- scheduled heartbeat: stale/block/failure scan
- on mission close request: completion/impossible report check

### D. `failure_diagnosis` event/object

Mission owner가 실패를 단순 “실패”가 아니라 복구 가능한 원인으로 분류하는 기록이다.

#### category 초안

- `info_missing`: 재현/증상/시간대/권한/입력 부족
- `authority_missing`: 현재 role/agent 권한 밖 조치 필요
- `external_dependency`: 벤더/고객/외부 API/장비 응답 필요
- `tool_failure`: adapter/tool/runtime/infra 실패
- `kb_gap`: 필요한 시스템 지식 또는 운영 절차가 KB에 없음
- `workflow_gap`: workflow step 정의/순서/입출력 계약이 부족함
- `scope_contract_unclear`: 계약/범위/책임 경계 불명확
- `approval_required`: 비용/외부 발송/법무/보안/운영파괴 가능성으로 승인 필요

#### 필드 초안

```ts
type FailureDiagnosis = {
  id: string;
  companyId: string;
  missionId: string;
  source: { type: "issue" | "workflow_step" | "heartbeat_run" | "delegation" | "manual"; id?: string | null };
  category: string;
  summary: string;
  evidence: Array<{ type: "log" | "comment" | "status" | "artifact" | "run"; ref?: string | null; excerpt?: string | null }>;
  attemptedRecovery: string[];
  nextDecisionNeeded?: string | null;
  diagnosedByAgentId?: string | null;
  createdAt: string;
};
```

### E. recovery/replan artifact

Plan revision과 실제 복구 조치를 연결하는 기록이다.

#### 필드 초안

```ts
type RecoveryReplanArtifact = {
  id: string;
  companyId: string;
  missionId: string;
  fromPlanRevision: number;
  toPlanRevision?: number | null;
  diagnosisIds: string[];
  action: "retry" | "reassign" | "request_info" | "escalate" | "fallback_path" | "narrow_scope" | "pause";
  reassignment?: { fromRole?: string | null; toRole?: string | null; toAgentId?: string | null } | null;
  additionalInfoRequest?: string | null;
  escalationTarget?: string | null;
  fallbackPath?: string | null;
  rationale: string;
  createdByAgentId: string;
  createdAt: string;
};
```

#### 사용 방식

- mission owner가 “왜 다시 계획했는지”를 남긴다.
- replan은 기존 plan을 삭제하지 않고 revision chain으로 남긴다.
- retry는 blind retry가 아니라 diagnosis/rationale에 연결한다.

### F. completion/impossible report

Mission close 시 “완료”와 “완료 불가” 모두를 evidence 기반으로 보고하는 최종 상태 문서다.

#### 필드 초안

```ts
type MissionOutcomeReport = {
  id: string;
  companyId: string;
  missionId: string;
  outcome: "completed" | "impossible" | "cancelled" | "partial";
  ownerAgentId: string;
  completedEvidence: Array<{ type: "issue" | "workflow_run" | "artifact" | "comment" | "test"; id?: string | null; summary: string }>;
  impossibleReason?: string | null;
  triedRecovery: string[];
  remainingDecisions: string[];
  roleAccountability: Array<{ role: string; agentId?: string | null; responsibility: string; result: string }>;
  recommendedNextStep?: string | null;
  createdAt: string;
};
```

#### 사용 방식

- mission status를 `completed`로 바꾸기 전 evidence checklist로 사용 후보.
- impossible이면 blocked reason과 remaining decision을 사용자/operator에게 보고한다.
- hard block은 아니며, missing report는 observation/needs_reason에서 시작한다.

## 4. 현재 schema/API/service 연결 후보: confirmed vs proposed

### Confirmed: 현재 존재하고 재사용 가능한 substrate

| 영역 | 확인된 요소 | 연결 후보 |
| --- | --- | --- |
| Missions | `missions.ownerAgentId`, `status`, `goalId`, `startedAt`, `completedAt` | mission owner identity와 lifecycle의 기준점. `ownerAgentId`는 outcome owner로 해석 가능. |
| Mission agents | `mission_agents.role` = executor/reviewer/observer | 참여자 registry. 세부 responsibility 위임에는 부족하므로 delegation record가 필요. |
| Mission sessions | `mission_sessions`의 active session, adapterType, lastActiveAt, runCount | mission owner/agent continuity와 supervision loop의 liveness source. |
| Main executor issues | `mission_main_executor_plan`, `mission_main_executor_oversight` originKind issue 자동 생성 경로 | prompt-only보다 한 단계 나은 issue-based planning/oversight placeholder. 구조화된 plan artifact로 승격 후보. |
| Workflow runs | `workflow_runs.missionId`, status, workflowId, timestamps | mission plan의 workflowRefs와 supervision state source. |
| Workflow step runs | `workflow_step_runs.workflowRunId`, `stepId`, `issueId`, status, timestamps | delegation/progress/failure diagnosis의 step-level source. |
| Issues | `issues.missionId`, assignee, status, originKind, executionRunId, parentId | delegation target, progress state, result/evidence link로 재사용 가능. |
| Activity log | `activity_log` action/entity/details/runId/agentId | diagnosis/recovery/completion report event를 처음에는 details payload로 실험 가능. |
| Heartbeat runs/events | heartbeat run status and mission session links in runtime services | tool_failure, stale run, adapter failure diagnosis source. |
| Worktree Rules/KB context | Phase A roleContext and maintenance decision context | mission plan의 ruleRefs/kbRefs 입력으로 재사용 후보. |

### Proposed: 새 persistent model 또는 확장 후보

| Proposed object | 이유 | 가능한 구현 위치 |
| --- | --- | --- |
| `mission_plan_artifacts` | issue description만으로는 revision, assumptions, success criteria, rule/KB refs를 안정적으로 추적하기 어렵다. | 새 table 또는 mission artifact document type. |
| `mission_delegation_records` | `mission_agents.role`은 참여자 registry일 뿐 responsibility 단위 위임을 표현하지 못한다. | 새 table, issue metadata, 또는 activity_log event로 spike. |
| `mission_failure_diagnoses` | 실패 category/evidence/recovery/decision-needed를 구조화해야 supervision/replan이 가능하다. | 새 table 또는 activity_log details에서 M0/M1 spike. |
| `mission_replans` | plan revision, reassignment, escalation, fallback path chain이 필요하다. | plan artifact revision table 또는 event stream. |
| `mission_outcome_reports` | completed/impossible evidence와 remaining decision을 close 상태와 분리해 보관해야 한다. | 새 table/artifact; 초기에는 issue/comment/activity로 spike 가능. |
| supervision scheduler/loop | stale/block/failure detection은 상태를 주기적으로 읽고 decision event를 남겨야 한다. | mission service scheduled job, heartbeat hook, workflow reconciler extension. |

## 5. Phase sequencing

### M0 — docs/spike only (현재 단계)

- substrate 객체와 current schema 연결 후보를 문서화한다.
- 코드/DB/API/UI 변경 없이 다음 최소 구현 slice를 결정한다.

### M1 — `mission_plan` artifact 최소 persistent model

- 목표: mission owner가 최신 plan revision을 저장/조회할 수 있게 한다.
- 최소 필드: missionId, revision, ownerAgentId, goal, assumptions, requiredInputs, successCriteria, steps, refs.
- Agent runtime에는 최신 active plan summary만 주입한다.
- 기존 `mission_main_executor_plan` issue와 연결하거나 대체하지 않고 병행한다.

### M2 — delegation records

- 목표: plan step별 role/agent responsibility assignment를 구조화한다.
- issue/workflow step과 연결해 expected output, handoff context, blocked/stale state를 기록한다.
- `mission_agents`는 roster, `delegation_record`는 responsibility-level assignment로 구분한다.

### M3 — supervision loop / stale detection

- 목표: mission owner가 읽는 상태 sources를 주기적으로 집계하고 next-action 후보를 생성한다.
- stale/block/failure/unowned work/completion gap 감지.
- hard block 없이 `mission_supervision_observed` 같은 observation event부터 시작한다.

### M4 — failure diagnosis + recovery/replan

- 목표: failure category, evidence, attempted recovery, next decision needed를 구조화한다.
- replan artifact로 reassignment, retry, info request, escalation, fallback path를 기록한다.
- retry는 diagnosis/rationale 없이는 “blind retry”로 관찰한다.

### M5 — completion/impossible report UI/API

- 목표: mission close 전에 completed evidence 또는 impossible reason을 operator가 볼 수 있게 한다.
- completed, partial, impossible, cancelled outcome을 evidence와 role accountability로 보고한다.
- UI/API는 이 단계에서 검토하며, 이전 단계에서는 service/artifact 중심으로 유지한다.

## 6. 테스트 전략 초안

코드 구현 시 TDD 대상은 다음 순서로 둔다.

### M1 tests: mission plan artifact

- manual mission 생성 시 ownerAgentId를 owner로 하는 initial plan artifact를 만들 수 있다.
- workflow-created mission은 workflowRefs를 포함한 plan artifact를 만들 수 있다.
- plan revision update는 이전 revision을 보존하고 active revision을 갱신한다.
- runtime/brief context는 최신 active plan summary만 포함하고 전체 history를 덤프하지 않는다.

### M2 tests: delegation records

- plan step을 role/agent/issue에 위임하면 delegation record가 생성된다.
- issue status가 blocked/done으로 바뀌면 delegation state 후보가 갱신된다.
- mission_agents roster에 없는 agent 위임은 명시적 add 또는 validation path가 필요하다.
- delegation expectedOutput과 handoffContext가 step input manifest에 요약된다.

### M3 tests: supervision loop

- staleAfter가 지난 delegation은 `stale` observation을 생성한다.
- workflow step failed는 failure diagnosis 후보를 생성한다.
- missionId가 있는 open issue 중 delegation 없는 issue는 unowned work observation으로 잡힌다.
- all-done처럼 보이나 success criteria evidence가 없으면 completion gap observation을 만든다.

### M4 tests: failure diagnosis / replan

- tool failure, info missing, external dependency, authority missing을 fixture별로 분류한다.
- recovery/replan은 diagnosisIds와 rationale 없이 생성되지 않는다.
- reassign/retry/request_info/escalate/fallback_path가 plan revision 또는 delegation state와 연결된다.
- same failure 반복 시 blind retry가 아니라 escalation/replan 후보가 생성된다.

### M5 tests: completion/impossible report

- completed report는 success criteria별 evidence를 요구한다.
- impossible report는 impossibleReason, triedRecovery, remainingDecisions를 포함한다.
- report 생성은 mission status update와 분리되어 테스트 가능해야 한다.
- UI/API가 추가될 때 mission detail에 latest outcome report summary를 표시한다.

## 7. 다음 구현으로 바로 할 최소 slice 추천

추천 slice: **M1 mission plan artifact 최소 persistent model**.

이유:

- Mission owner substrate의 중심 객체다.
- delegation/supervision/failure/replan/report가 모두 plan revision 또는 plan step을 기준으로 연결된다.
- 현재 `mission_main_executor_plan` issue가 이미 존재하므로, 이를 대체하지 않고 구조화 artifact를 병행 생성하는 작은 slice로 시작할 수 있다.
- Phase A roleContext와 충돌하지 않고, Phase B audit event 확장으로 새지 않는다.

단, 구현은 사용자 승인 후 진행한다.
