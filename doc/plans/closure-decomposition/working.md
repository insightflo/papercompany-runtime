# 작업 진행 상태 — 클로저 분해 (P4/P5)

> 설계: `plan.md`. 이 파일은 매 step 업데이트. 중단 시 새 세션이 이 파일을 읽고 이어서 진행.

## 현재 상태
- **Phase**: P0 + P1 **완료+push** → **P2 진행 예정**
- **missions.ts**: 3727 → **3550줄** (P4 누적 -177)
- 분리 모듈(P4): shared-types.ts(16) + supervision-helpers.ts(203)
- **commit/push**: 최신 `3ed4ea9` (P0+P1). BOOT OK.

## 완료 로그
- [x] 설계 plan.md + reviewer 검토(NEEDS_REVISION→반영)
- [x] P0: shared-types.ts (IssueRow/IssueCreateInput/JsonRecord) — tsc+136 test
- [x] P1: supervision-helpers.ts (Layer 0 순수 helper 22개) — tsc+136+workflow-dag-engine 45 test

## 다음 (P2 — Layer 1 owner-actions factory, 위험 중~고)
- 대상: createMissionOwnerActionIssue, isMissionOwnerActionParentPlacementRejected, findMainExecutorIssue, ensureMainExecutorPlanningIssue, ensureWorkflowMissionPlanArtifact, ensureMainExecutorUnblockIssue, ensureToolStepFailureRecoveryIssue, ensureMainExecutorOversightIssue, ensureMissionExecutionPlan, reconcileMissionStatusFromWorkflowRuns, completeOpenMissionOversightIfSettled, collectWorkflowIssueIdsForMission, collectIssueIdsWithAncestors, ensureWorkflowIssuesLinkedToMission, reopenAppliedToolStepRecoveryIfRetryFailed, closeDuplicateToolStepRecoveryIssue, listRecurringArtifactMissingIssueRefs, buildCorrectedArtifactValidatorRetryEvidence
- 방식: `missions/owner-actions.ts` factory `createOwnerActions({db, deps})` 반환. missions.ts에서 호출.
- 내부 클러스터(ensureMissionExecutionPlan↔ensureMainExecutorOversightIssue↔ensureWorkflowMissionPlanArtifact) 동시 이동 필수.
- 검증: tsc + mission 136 + workflow-dag-engine 45.

### P2 설계 상세 (2026-06-20 분석)
- **Layer 1은 현재 연속 블록**(421~1360, P1로 Layer 0 helper가 빠져서) → awk로 한 번에 추출 가능.
- **외부 의존**:
  - `issueService(db)`: create(5)/addComment(10)/update(2) — db에서 파생, factory 내 OK.
  - `deps`: onOwnerActionCreated(6)/onOwnerDecisionRetrySourceIssueApplied(4)/onStaleSourceIssueWakeupRequested(2)/onOwnerPlanningIssueCreated(2)/cancelHeartbeatRun(2) — factory 주입.
  - imported builder: mergeMissionPlanRefs, summarizeMissionPlanForRuntime(mission-plan-artifacts), extractLatestMissionOwnerDecision, buildMissionOwnerDecisionWakeupIdempotencyKey(mission-owner-recovery-events), buildOwnerActionExplanations/buildMissionOwnerActionExplanations(mission-owner-recovery-explanations + top-level 237), buildMissionSupervisionContext, buildMissionRuleContext, buildMissionOwnerUnblockDescription(mission-owner-recovery-comments), buildMissionOwnerDecisionFormat, buildMissionExecutionDigest(2).
  - helpers: supervision-helpers(asRecord/trimmedString/parseToolStepRecoveryMarker 등) + isTerminalStatus(top-level 297, pure).
- **factory 인터페이스**: `createOwnerActions({db, deps}: {db: Db, deps: MissionServiceDeps})` → 18함수 반환 객체.
- **재배선**: missionService CRUD/supervision에서 이 함수들 호출부 → `ownerActions.X`로 변경(약 30+ call site).
- **위험**: deps 콜백 바인딩, call site 누락. tsc가 누락 잡음(미정의 참조). 136+45 test로 회귀 확인.

## 검증 게이트 (매 phase)
- `pnpm --filter @paperclipai/server typecheck` exit 0
- `pnpm vitest run server/src/__tests__/missions-service.test.ts server/src/__tests__/mission-owner-recovery-comments.test.ts server/src/__tests__/mission-owner-supervision-monitor.test.ts server/src/__tests__/mission-owner-plan-decisions.test.ts` 136/136
- 서버 restart boot OK (tmux `papercompany-runtime-dev`)
- commit + push

## 주의
- 같은 파일(missions.ts) 다수 편집 → 순차(동시 편집 충돌 회피).
- swarm ≤5: 검토/분석 병렬에 활용, 같은 파일 편집은 순차.
- security-scan hook이 큰 파일 편집 시 오탐 블록(advisory, 적용은 됨).
