# missions.ts 클로저 분해 설계 (P4/P5)

> 작성: 2026-06-20. 진행 상태는 `working.md` 참조.
> 배경: missions.ts(4176→현재 3727줄)에서 독립 조각 5개(utils/workflow-progress/tool-step-failure/supervision-types/plugin-workflow)는 이미 분리 완료. **남은 ~3000줄은 `missionService(db, deps)` 팩토리 내부의 클로저들** — 바깥 변수(db/deps)에 결합되어 단순 이동 불가. factory decomposition으로 풀어야 함.

## 1. 클로저 호출 그래프 (의존 지도)

missionService 내부 클로저를 의존 계층별로 분류:

### Layer 0 — 순수 helper (db/deps 무, supervision 전용)
`asRecord`, `asRecordArray`, `trimmedString` (로컬 캐스터, utils와 별개 — `{}`/`[]` 반환), `normalizedPlanStatus`, `executionUnitKey`, `executionUnitKeyFromSourceRef`, `textContainsAny`, `unitRequiresGovernedAction`, `isApprovalRuleMode`, `hasDiagnosisSignal`, `jsonArrayLength`, `sourceRefMatchesIssue`, `materializedRefMatchesIssue`, `activePlanPaqoStepMatchesIssue`, `activePlanRecoveryGateReason`, `hasArtifactMissingSignal`, `hasRecoverableArtifactComment`, `parseToolStepRecoveryMarker`, `toolStepRecoveryMarkerKey`, `findCanonicalToolStepRecoveryIssue`, `buildNativeToolStepRetryAppliedMarker`, `hasNativeToolStepRetryAppliedMarker`, `buildCorrectedArtifactValidatorRetryEvidence`

→ 서로 호출(내부 클러스터) + Layer 0 캐스터 사용. supervision(runMainExecutorSupervision)이 대부분 호출.

### Layer 1 — db/deps actions (owner-action issue 생성/회수/정리)
`createMissionOwnerActionIssue`, `isMissionOwnerActionParentPlacementRejected`, `findMainExecutorIssue`, `ensureMainExecutorPlanningIssue`, `ensureWorkflowMissionPlanArtifact`, `ensureMainExecutorUnblockIssue`, `ensureToolStepFailureRecoveryIssue`, `ensureMainExecutorOversightIssue`, `ensureMissionExecutionPlan`, `reconcileMissionStatusFromWorkflowRuns`, `completeOpenMissionOversightIfSettled`, `collectWorkflowIssueIdsForMission`, `collectIssueIdsWithAncestors`, `ensureWorkflowIssuesLinkedToMission`, `reopenAppliedToolStepRecoveryIfRetryFailed`, `closeDuplicateToolStepRecoveryIssue`, `listRecurringArtifactMissingIssueRefs`

→ db + deps(onOwnerActionCreated 등) + Layer 0 + 타입 사용. 서로 호출(createMissionOwnerActionIssue 중심).

### Layer 2 — supervision 본체
`runMainExecutorSupervision` (~1100줄, 핵심), `isActiveSupervisionExecutionStatus`, `runActiveMissionOwnerSupervision`

→ Layer 0 + Layer 1 + db + deps 호출. (의존의 뿌리)

### Layer 3 — CRUD (missionService 반환 객체의 공개 메서드)
`create`, `getById`, `list`, `update`, `deleteMission`, `addAgent`, `removeAgent`, `updateAgentRole`, `listAgents`, `getIssueTree`, `listWorkflowRuns`

→ Layer 1/2 호출. missions.ts에 잔류(공개 서비스 메서드).

## 2. 타입 의존 (분해 전 해소 필요)
- `MissionExecutionUnit` / `MissionExecutionStatus`: 이미 `mission-execution-sources.ts`에 있음(접근 가능) ✅
- `JsonRecord`: 로컬 alias `Record<string, unknown>` (1214) — trivial, shared-types로 이동
- `IssueRow` (`typeof issues.$inferSelect`), `IssueCreateInput`: private → shared-types로 이동
- `MissionSupervisionPlanArtifact`, `MissionSupervisionHeartbeatRun`, `MissionSupervisionWorkflowStepRow`: `mission-supervision-context.ts`에 있음(접근 가능) ✅

## 3. 목표 구조 (factory decomposition, leaf-first)

```
server/src/services/missions/
  shared-types.ts       (P0) IssueRow, IssueCreateInput, JsonRecord + 기존 core 타입 re-export
  supervision-helpers.ts(P1) Layer 0 순수 helper들 (module-level pure functions)
  owner-actions.ts      (P2) createMissionOwnerActionIssue + ensure* + reconcile + collect* + reopen/close + listRecurring
                              factory: createOwnerActions({ db, deps }) => { ensureMainExecutorUnblockIssue, ... }
  supervision.ts        (P3) runMainExecutorSupervision + runActive + isActive
                              factory: createSupervision({ db, deps, ownerActions, helpers }) => { runForMission, runActive }
server/src/services/missions.ts  CRUD(create/get/list/update/...) + missionService 팩토리 조립
```

각 factory는 명시적 주입(`{ db, deps }`)으로 클로저 공유를 대체 → 별도 파일로 이동 가능.

## 4. 단계별 실행 (leaf-first, 각 phase tsc + mission test 136 + restart boot 게이트)

| Phase | 대상 | 방식 | 위험 |
|---|---|---|---|
| **P0** | shared-types.ts (IssueRow/IssueCreateInput/JsonRecord) | 타입 이동 + re-export | 낮 |
| **P1** | supervision-helpers.ts (Layer 0 ~24 pure helper) | module-level pure fn으로 이동 | 낮~중 (타입 의존) |
| **P2** | owner-actions.ts (Layer 1) factory `createOwnerActions({db,deps})` | 클로저→factory 변환 (deps 주입) | **중~고** (db/deps 재배선) |
| **P3** | supervision.ts (Layer 2) factory `createSupervision(...)` | 1100줄 본체 + deps/ownerActions 주입 | **고** (가장 크고 결합) |

- 각 phase 끝: `pnpm --filter @paperclipai/server typecheck` + `vitest run mission test 4file` + 서버 restart boot 확인 → commit.
- P2/P3는 factory 변환이라 행동 변경 가능 → mission test + supervision-monitor test로 회귀 엄밀히.

## 5. swarm 사용 (동시 ≤5)
- Layer 0 helper들은 서로 호출하지만 개별 이동은 독립적 → P1에서 최대 5 sub-agent로 병렬 추출 가능 (각 agent: helper 그룹 이동 + import 정리).
- 단, 같은 파일(missions.ts) 동시 편집 충돌 회피 → **worktree 격리** 또는 **순차**(같은 파일 다수 편집은 순차가 안전). P1은 missions.ts 단일 파일 편집이라 **순차** 권장.
- swarm은 **검토/분석 병렬**(설계 검증, phase별 회귀 분석)에 주로 활용.

## 6. 검토 게이트 (필수)
- 설계(plan.md) 작성 후 → **claude peer(현재 실행중) 검토**, peer 불가 시 **오염되지 않은 신규 sub-agent** 검토.
- 검토 통과 후 P0부터 진행.

## 7. 중단 대비 (working.md)
- `working.md`에 매 step 진행/상태/다음 작업 기록. 중단 후 새 세션이 working.md 읽고 이어 가능.

---

## 8. 검토 결과 반영 (2026-06-20, reviewer sub-agent — NEEDS_REVISION → 수정 반영)

골격(Layer 분류/leaf-first/factory 방향)은 코드 기반으로 정확. 아래 정정/보강 반영:

### 정정
- **isMissionOwnerActionParentPlacementRejected(406)**: 순수 타입 가드(db/deps 무) → 엄밀히 Layer 0. 단 createMissionOwnerActionIssue만 호출하므로 **owner-actions.ts에 동행**시키는 게 실용적(분류 기준 예외로 명시).
- **createMissionOwnerActionIssue → `create` 엣지 오탐**: 본문은 `issueService(db).create(...)` 호출(CRUD `create` 아님). 호출 그래프에서 제거/명시.
- **Layer 1 ↔ CRUD 순환: 없음(확인)** ✅. `reconcileMissionStatusFromWorkflowRuns`(435)·`completeOpenMissionOversightIfSettled`(631)는 CRUD `update()`가 아니라 **원시 `db.update(missions)` 쿼리** 사용 → 역방향 호출 없음. factory 분해 안전(순환 무). 긍정 요소.
- **CRUD도 `{db, deps}` 필요**: `deps.onOwnerPlanningIssueCreated`(create 2912), `deps.cancelHeartbeatRun`(update 3116) 사용. CRUD는 missions.ts 잔류하되 deps 계속 주입.

### P3 supervision 검증 강화 (필수 — review 핵심 우려)
현재 게이트(tsc+mission test 4file)만으로 1109줄 회귀 부족:
- `mission-owner-supervision-monitor.test.ts`는 `runActiveMissionOwnerSupervision`을 **mock**(vi.fn, line 3) → 본체 미실행.
- ∴ supervision 본체 회귀는 `workflow-dag-engine.test.ts`의 supervision call sites에 전적으로 의존.
- **P3 진입 전(조건)**:
  1. workflow-dag-engine.test.ts supervision call sites(~9건)가 본체를 비-mock 실실행하는지 확인 → 게이트로 명시.
  2. 프로덕션 supervision 호출 경로 식별(`POST /missions/:id/supervision/run` 경유 추정) + 해당 라우트 회귀 확인.
  3. factory 변환 후 `deps.onStaleSourceIssueWakeupRequested`/`deps.onOwnerDecisionRetrySourceIssueApplied` 콜백이 **동일 시점·동일 인자**로 호출됨을 단언하는 회귀 테스트 1건 **P3 직전에 추가**.

→ P0~P2는 현재 136 test로 충분(supervision 본체 미건드는 안전 이동). P3만 위 강화 적용.
