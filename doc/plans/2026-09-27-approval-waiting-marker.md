# Approval Waiting Marker — 승인 대기 관찰 가능성 마커 (로드맵 5/5 = ④)

Date: 2026-09-27
Branch: `insightflo/approval-waiting-marker`
Status: 구현·검증 완료 (커밋 없음 — 워크트리 변경만)

## 최종 목표와 승인 범위

로드맵 확정 문구: "승인 대기 표지 — 관찰 가능성(대기/idle/복구 구분) 최소 마커".
배경 원인: "대기/idle/복구 중 구분 불가 → timeout·자동취소 정책 오작동".
보정 맥락: 운영자 결정 장부(operator_decisions, status pending/resolved/cancelled)는 이미
내구적 — 갭은 관찰 가능성만. 저비용 마커가 본체 (새 상태머신·새 승인 절차 금지).

이번 슬라이스: (1) 감사(대기 발생 지점 + 오작동 정책 분류), (2) 파생 마커 표면 2종
(조회 API 파생 필드 + 스위프/감독 면제 조건), (3) embedded PG 테스트, (4) 전체 검증.
commit/push/merge/deploy 금지(워크트리 변경만).

## 선행 완료

- #277 런 상태 CAS, #278 스텝 상태 CAS(③-1/2), #279 effect envelope(②), #280 체크포인트+종료(①).

## 1단계 감사 (2026-09-27, 읽기 전용 병렬 감사 완료)

### (a) 대기 발생 지점 — 단일 사실 원천은 기존 내구 데이터

| 원천 | 대기 상태 어휘 | 키 | 대기 중 표면 |
|---|---|---|---|
| `operator_decisions` | `status='pending'` | `issueId`(부분 인덱스) / `sourceContext.workflowRunId`, `sourceId='<runId>:...'` 접두사 | 런 종료 후 이슈 `in_progress` 유지(웨이크업 없음) 또는 런 중간 프로세스 생존 대기. 해결 시 continuation worker 가 재깨움 |
| `approvals` × `issue_approvals` | `status in ('pending','revision_requested')` | `issue_approvals.issueId`(인덱스) → approvals 조인 | 이슈 실행 직접 차단은 없음(감시·채택 게이팅) |

생성 지점 4곳(결정): 일반 쓰기 API(`operator-decisions-write.ts`), 품질 결정 카드
(`quality/decisions.ts`), 하트비트 누락-증거 카드(`heartbeat.ts`, requestKey
`missing-evidence:<issueId>`), QA 거부 소유자 카드(`workflow/qa-source-defect-owner-card.ts`).
승인: `approvals.ts`/`budgets.ts` 생성, `issue-approvals.ts` 이슈 링크.

### (b) 오작동 정책 분류 — 면제 대상 3곳, 나머지 (b)-안전

| 정책 | 지점 | 위험 | 분류 |
|---|---|---|---|
| 실행 타임아웃 리퍼 | `heartbeat.ts reapOrphanedRuns` (running 런, step-aware timeout→`timed_out`/`execution_stale_timeout`, 자식 kill) | 프로세스 생존·사람 대기 중인 런을 hang 으로 오판 | **면제** |
| queued-stale 스위프 | `heartbeat.ts` (queued 런→`failed`/`stale_queued`; 고아 queued 웨이크업→`failed`) | 대기 이슈의 재대기열 런/웨이크업을 phantom 으로 회수 | **면제** |
| 감독 stale_in_progress | `missions/supervision.ts` (in_progress+30분+live 없음→`stale_in_progress_*` 파인딩+재시도/리플랜 추천+unblock 회복 이슈) | 사람 대기 이슈을 stale 로 오탐, 회복 이슈 난립 | **면제 + `operator_approval_waiting` 파인딩으로 분류** |
| no-progress 래더, busy-runtime 리퍼, 실행잠금 리퍼, terminal-mission orphan sweep, shutdown flush, 워크플로 max-retry, continuation 수동 재시도, 예산 하드스톱 | — | 성공런/터미널실패/터미널미션/사용자요청 전제라 대기 중 엔티티 미접촉, 예산은 의도된 불변(스스로 `budget_override_required` 승인 생성) | (b)-안전 (변경 없음) |

백그라운드 스위프 어디도 pending 결정/승인을 조회하지 않음(grep 확인) — 마커가 면제 유일 소스.

## 2단계 구현 (최소 마커)

- 신규 `server/src/services/operator-approval-wait.ts`(113줄): 배치 판정만, 저장 없음.
  `markersForIssueIds`(이슈 집합 → 결정/승인 id 마커, 각 1회 쿼리), `markerForIssue`,
  `markerForWorkflowRun`(`(companyId,status)` 인덱스로 pending 좁힌 뒤
  `sourceContext->>'workflowRunId' = :runId OR sourceId LIKE '<runId>:%'`).
  DTO: `{waiting, operatorDecisionIds, approvalIds}`, 응답 필드명 `waitingOnOperatorApproval`.
- 표면 (i) 조회 API 파생 필드:
  - 이슈 목록 `GET /companies/:id/issues` — svc.list 배치 부착(`withOperatorApprovalWait`).
  - 이슈 상세 `GET /issues/:id` — 라우트 부착.
  - 하트비트 런 상세 `GET /heartbeat-runs/:runId` — `run.issueId` 기준 라우트 부착.
  - 워크플로 런 `GET /workflow-runs/:runId[,/detail]` — 런 키 마커 라우트 부착.
- 표면 (ii) 면제 조건: 위 (b) 3곳에 배치 마커 조회 1회 + `waiting=true` 이면 skip
  (logger.info 로 증거 로그). 감독은 stale 파인딩 대신 `operator_approval_waiting`
  정보성 파인딩으로 대체(회복 이슈/추천 생성 안 함).
- 사람 노출: 보드는 이미 `GET /companies/:id/operator-decisions`·`/approvals` 로 대기 목록
  열람 가능 — 파생 필드는 맥락(런/이슈 화면)을 보강한다. UI 컴포넌트 작업은 제외(승인 범위).

## 3단계 테스트 (embedded PG)

- `operator-approval-wait-marker.test.ts`: (a) 목록 파생 필드 true+ids → resolve 후 소멸,
  워크플로 런 키(sourceContext/sourceId 접두사) 판정.
- `operator-approval-wait-sweeps.test.ts`: (a) queued 런·고아 웨이크업·실행 타임아웃 면제
  (실제 자식 프로세스 + runningProcesses 주입), (b) 결정 cancelled 후 정상 회수 복귀,
  (c) 무관 stale queued 런 기존대로 `failed/stale_queued`.
- `operator-approval-wait-supervision.test.ts`: (a) `operator_approval_waiting` 분류+
  회복 이슈 미생성, (b) resolve 후 `stale_in_progress_no_execution` 복귀+unblock 이슈 생성.
- 대표 회귀: heartbeat-process-recovery, mission-stopped-execution-liveness,
  heartbeat-scheduler (36/36 통과).

## 검증

`pnpm -r typecheck` / 전체 `pnpm test:run` / `pnpm build` — 최종 보고에 출력 원문 첨부.

## 제외 항목 (미구현 의도적)

새 상태머신/새 승인 절차, UI 컴포넌트, operator_decisions·approvals 스키마 변경,
알림·에스컬레이션 신설, 펜싱/봉투/체크포인트 변경(선행 완료), process_lost 경로 면제
(프로세스 실제 상실은 유한 재시도 회복 경로 유지 — 면제 시 phantom running 영구 잔류 위험).
