# 2026-09-26 — 스텝 상태 펜싱 (step-status fencing v1)

로드맵: 실행 상태 테이블의 좀비쓰기(늦은 실행자의 상태 덮어쓰기) 방지 3단계 중 2단계.

1. heartbeat_runs `setHeartbeatRunStatus` CAS화 — #277 완료.
2. **workflow_step_runs 상태 전이 쓰기 펜싱 — 이 문서(현재 슬라이스).**
3. (후보) 잔여 workflow_step_runs 쓰기 파일들 — 별도 슬라이스에서 분류.

## 최종 목표와 승인된 범위

- 목표: dag-engine.ts / workflow-step-issue-records.ts 내 `update(workflowStepRuns)` 14곳을
  분류하고, 상태 전이 쓰기에 기대 pre-state CAS(WHERE `inArray(status, ...)`)를 건다.
  0행 폐기 시 `logger.info("fenced step-status write discarded", {stepRunId, attempted, expected})`.
- 제외(승인 경계): heartbeat_runs(1단계 완료), lease 컬럼 신설, 동시성 잠금 추가,
  terminal-parent 가드 변경, 에이전트 상태 테이블, 기타 파일의 step 쓰기.

## 분류 결과 (14곳)

| 지점 | 분류 | 조치 |
| --- | --- | --- |
| dag-engine L524 `syncStepRunExecutionControlMetadata` | (b) metadata 전용 | 변경 없음 |
| dag-engine L1266 이슈상태 동기화 루프 | (a) 전이 | 스냅샷 status CAS + 기존 세대/metadata CAS 유지 |
| dag-engine L1300 `resetUnlaunchedTerminalStepRuns` | (a) skipped/failed→pending | 행별 status CAS(["skipped","failed"]) |
| dag-engine L2087 `failMalformedCompletedControlNodes` | (c) 이미 CAS(eq status completed) | 그대로 |
| dag-engine L2421 `blockToolStepRunForConcurrency` | (a) 전이 | 스냅샷 status CAS |
| dag-engine L2465 `completeToolStepRunFromCache` | (a) 전이 | 스냅샷 status CAS |
| dag-engine L2481 `failToolStepRun` | 사장 코드(호출부 0) | 변경 없음 — 제거 후보 |
| dag-engine L2517 `failToolStepRunWithDispatchError` | (a) 전이 | 스냅샷 status CAS(폐기 시 전이기록 생략) |
| dag-engine L2685 `startIssueLessToolStepRun` running 전이 | (a) 전이 | 스냅샷 status CAS |
| dag-engine L2912 큐 claim | (b)+(c) 상태 미설정 + claim CAS | 변경 없음 |
| dag-engine L3309 `completeWorkflowToolStepFromResult` | (c) completionCasCondition | 그대로 |
| dag-engine L4263 issueId 바인딩 | (b) issueId 전용 | 변경 없음 |
| dag-engine L4321 동적 런치 미발화 skip | (a) pending→skipped | status CAS(["pending"]) |
| workflow-step-issue-records L66 바인딩 CAS | (b)+(c) isNull(issueId) CAS | 변경 없음 |

(d) 기대 상태 애매 → 미적용 지점은 없음. 스냅샷 status CAS는 호출부가 넘긴 로드 시점
상태를 그대로 기대 pre-state로 쓰므로 문맥이 항상 확정된다.

## 구현

- 신규 `server/src/services/workflow/step-status-fencing.ts`: `setWorkflowStepRunStatus`
  중앙 헬퍼(기존 범용 헬퍼 부재로 1개 신설). `setHeartbeatRunStatus`(#277)와 동일 계약 +
  `extraConditions`(세대 CAS 등 기존 울타리 보존).
- dag-engine.ts 7개 지점을 헬퍼 경유로 전환. status_transition_version 트리거
  (migration 0080)는 값이 실제로 바뀔 때만 +1이므로 같은 값 재기입 부작용 없음.

## 완료 증거 (2026-09-26 실행)

- `pnpm -r typecheck` 통과 (전체 패키지 Done).
- 신규 `server/src/__tests__/workflow-step-status-fencing.test.ts` 4/4 통과 (embedded PG).
- 대표 회귀 통과: workflow-control-node-execution + workflow-resume-acceptance +
  workflow-dag-engine + run-late-result-fencing (114 tests), workflow-tool-claim-orphan-reconciler
  + heartbeat-run-status-fencing + workflow-step-status-provenance.integration +
  workflow-step-retry-scheduler-cas + workflow-step-retry-dispatch-cas +
  quality-native-delivery-current-output (17 tests).
- 전체 스위트: 911 files / 6877 passed, 1 skipped. `pnpm build` 통과.

## 남은 작업 (이 슬라이스 외)

- 3단계 후보: server/src 내 잔여 파일의 `update(workflowStepRuns)` 쓰기(resume/reset.ts,
  conditional-skip-settlement.ts, workflow-cancelled-state.ts 등 — 다수 이미 자체 CAS 보유).
- `failToolStepRun`(dag-engine L2475) 사장 코드 제거 여부 결정.
