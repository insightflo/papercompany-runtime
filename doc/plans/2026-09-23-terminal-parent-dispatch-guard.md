# 2026-09-23 — terminal-parent dispatch guard (좀비 큐 행 결함 수정)

## 최종 목표와 승인된 범위
- 사용자 승인: 확인된 결함 수정 + PR/CI/배포 진행 (2026-09-23 “수정. 배포 진행해”).
- 대상 결함: 종결(`failed` 등) 부모 run에 대한 late sync가 issue-less tool 후속 단계를
  `running + queued`로 materialize하고, reopen guard가 부모 부활만 거부하여 큐 selector
  (`workflow_runs.status='running'`)와 영구 어긋나는 좀비 큐 행 생성.
  근거: run `a551de30` 외 4건(34m/2h/26.2h/1.8h), 695건 중 >=10m 5건 전부 동일 서명,
  현재 유휴 좀비 5건(4 cancelled + 1 failed).

## 전체 필수 경로
1. RED 통합 테스트: `workflow-terminal-parent-dispatch-guard.test.ts`
2. 최소 수정: `syncWorkflowRunStateWithOutcome` — `syncStepRunsFromIssueState` 이후,
   revive/reset/skip-propagation/launch 진입 전에 종결 부모 가드(플래그 게이트) 조기 반환.
   늦은 선행 완료 근거는 transition ledger에 기록하고, 후속 생성/실행은 공식 재개까지 보류.
3. GREEN + 회귀: reopen-guard, frozen-queue, recovery 관련 스위트 + 전체 typecheck/test/build.
4. PR → CI green → merge → A1 수동 정확-SHA 배포(자동 배포는 은퇴됨) → 3계층 헬스 검증.

## 현재 단계와 미충족 완료 조건
- 현재: RED 테스트 작성 완료, 구현 전.
- 미충족: RED 실패 확인 → 구현 → GREEN → 전체 검증 → 병합 → 배포 증거(A1 SHA/헬스/큐 틱).

## 이번에 하지 않는 작업
- 큐 selector 완화(종결 권위 위반) 금지.
- 늦은 근거 기반 자동 재개 금지(복구 승인 아님, 규칙 9).
- 기존 좀비 5건의 DB 직접 수정 금지 — 공식 API 별도 운영 결정.
- sync가 running을 읽은 뒤 동시 종결되는 경합 선형화(별도 대형 작업).

## 조건별 완료 증거
- RED: 가드 단언(qa pending, toolQueue 부재, executor 미호출) 실패 출력.
- GREEN: 동일 테스트 통과 + legacy 플래그 off 유지 테스트 통과.
- 배포: merge SHA, A1 `git rev-parse HEAD` 일치, `systemctl is-active`, VM 로컬/퍼블릭 헬스 200.
