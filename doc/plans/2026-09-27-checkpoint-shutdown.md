# Checkpoint + Graceful Shutdown — 종료 플러시와 회수 정합 (로드맵 4/5)

Date: 2026-09-27
Branch: `insightflo/checkpoint-shutdown`
Status: 구현·테스트 완료 (커밋 없음 — 워크트리 변경만). 전체 검증(typecheck/test:run/build) 완료.

## 최종 목표와 승인 범위

로드맵 확정 문구: "체크포인트+우아한 종료 — **펜싱 완료 후에만 flush 쓰기 허용**; 이중 타이머(hang 방지)+스키마 검증+split-brain 방지".
핵심 원칙: SIGTERM 이후 "무슨 쓰기를 허용할 것인가"가 종료 계약의 본질. 전제(#277 CAS, #279 envelope) 병합 완료 확인.

이번 슬라이스: (a) 종료 플러시 마킹+재시도 정합+회수 사각지대 방어, (b) 체크포인트 참조 레코드(최소),
embedded PG 테스트, 전체 검증. 어댑터 CLI 내부 변경/승인대기 표지/lease/UI/effect_intents 스키마 변경 제외.

## 감사 결과 (2026-09-27)

- `server/src/index.ts` shutdown(~L667): SIGINT/SIGTERM → scheduler stop → tracked child SIGTERM → 2s grace →
  SIGKILL → exit(0). DB 표시 없음. 회복은 재시작 후 reaper가 pid 사망 발견 → process_lost 실패+CAS → 1회 재시도.
- `setHeartbeatRunStatus`(heartbeat.ts:3389): #277 CAS. expectedStatuses 비일치 시 "fenced run-status write discarded".
- `reapOrphanedRuns`(heartbeat.ts:5308): **`status='running'`만 스캔**. pid 사망 running 런 → CAS failed(process_lost)
  → processLossRetryCount<1 이면 `enqueueProcessLossRetry`(원자 tx: 깨움+재시도 런+dispatchGeneration 스탬프+이슈 락 이전),
  소진 시 fallback/`releaseIssueExecutionAndPromote`.
- `reapStalledIssueExecutionLocks`(heartbeat.ts:5877): lock 런 전원 종단실패+후계 런 없음 → 락 회수.
  → "mark만 하고 재시도 등록 실패"인 런도 락은 회수되나 **재시도 1회 정합은 상실** (사각지대).
- `enqueueProcessLossRetry`(heartbeat.ts:4725): withTxTimeout 원자 tx. `resolveSessionBeforeForWakeup`은
  heartbeatService 클로저 → 추출 대신 **flush 메서드를 heartbeatService 내부에 배치** (재시도/폴백 로직 단일 출처 유지).
- effect_intents(#279): attemptRunId 컬럼로 런 소속 intent 조회 가능. #276 커서: issues.last_operator_instruction_at/_comment_id.
- runningProcesses: `Map<runId, {child, graceSec}>` (adapter-utils). 런 행은 DB 조회 필요.
- zod: v3.24, "v1 strict" 스타일 = `version: z.literal(1)` + `.strict()` (tool-progress.ts 참조).

## 설계 (감사 기반 확정)

1. **flush = heartbeatService 신규 메서드 `markRunsShutdownInterrupted(runIds, {deadlineMs, signal})`**:
   - 런별: status!='running' 스킵(펜스) → CAS failed+errorCode `shutdown_interrupted`(error 메시지에 원인/시각/last pid,
     finishedAt) → **동일 reaper 후처리 미러**: retryCount<1+agent 존재 → `enqueueProcessLossRetry`(기존 그대로),
     소진+fallback 설정 → `enqueueAdapterFallbackRun`, 그 외 → release+promote. run event 기록.
   - (b) 체크포인트 레코드: CAS patch의 contextSnapshot.shutdownCheckpoint에 첨부(기존 컬럼 활용, 마이그레이션 없음,
     마킹과 원자). 스키마: `packages/shared` 신규 validator(shutdown-checkpoint.ts), version:1 strict —
     phase/interruptedAt/cause/signal/lastPid/sessionId/resumeToken/issueInstructionCursor/effectIntentIds/retryPlanned.
     검증 실패 → 첨부 생략+경고(마킹 자체는 진행).
2. **회수 사각지대 방어(reaper 백스톱)**: `reapOrphanedRuns`에 `failed+shutdown_interrupted+processLossRetryCount<1+
   후계 런(retryOfRunId) 부재` 스캔 추가 → `enqueueProcessLossRetry` 재사용. flush와 백스톱 사각 없음(후계 런 존재
   검사로 정확히 1회). flush 타임아웃/부분 실패가 아니어도 크래시-윈도우 커버.
3. **이중 타이머**: child grace(2s, 기존)와 독립 flush 데드라인 `PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS`(기본 3000,
   0=비활성). 초과분 스킵+로그(미마킹 런은 running 유지 → 기존 reaper 회수). 총 종료시간 ≈ max(2s, ≤3s)+PG stop
   ≈ ≤5s ≪ systemd 기본 TimeoutStopSec 90s / docker stop 10s.
4. **index.ts 배선**: scheduler stop → flush Promise와 child SIGTERM **병렬** → Promise.all(grace 대기) → SIGKILL →
   flush 결과 로그 → PG stop → exit(0). heartbeatService 인스턴스를 schedulerEnabled 조건 밖으로 hoist.

## 구현 결과 (2026-09-27)

- `packages/shared/src/validators/shutdown-checkpoint.ts` — shutdownCheckpointSchema(zod v1 strict) + index export.
- `server/src/services/shutdown-flush.ts`(신규) — 체크포인트 조립/검증(effectIntentIds, 지시 커서, sessionId/resumeToken),
  데드라인/요약 헬퍼, SHUTDOWN_INTERRUPTED_ERROR_CODE.
- `server/src/services/heartbeat.ts` — heartbeatService.markRunsShutdownInterrupted(런별 CAS 마킹+process_lost
  후처리 미터: enqueueProcessLossRetry / enqueueAdapterFallbackRun / releaseIssueExecutionAndPromote 재사용),
  reapOrphanedRuns 내 백스톱 스캔(failed+shutdown_interrupted+retryCount<1+후계 런 부재 → 재시도 1회 보충+원본 깨움 실패 처리).
- `server/src/config.ts` — shutdownFlushTimeoutMs(PAPERCLIP_SHUTDOWN_FLUSH_TIMEOUT_MS, 기본 3000, 0=비활성, 상한 60s).
- `server/src/index.ts` — heartbeat 인스턴스 hoist, 스케줄러 정지 후 child SIGTERM과 플러시 병렬(Promise.all), flush 결과 로그.
- `server/src/__tests__/heartbeat-shutdown-flush.test.ts` — 6건(마킹+CAS 펜스, 데드라인 스킵+총시간 상한, 백스톱 정확히 1회,
  소진 릴리즈, 스키마 불량 거부, sweep 이중 회수 부재) 통과.
- 회귀: heartbeat-process-recovery(22), heartbeat-run-status-fencing, workflow-step-status-fencing,
  effect-envelope(단위+통합) 전부 통과.

### 잔여 한계(보고용)

1. 백스톱 스캔은 status+errorCode 필터만으로 인덱스 없음 — 기존 running 스캔과 같은 비용류(sweep당 1회 추가 select, limit 50).
2. retryCount 소진 마킹 런의 fallback은 플러시 시에만 시도 — 크래시-윈도우(마킹 커밋 직후 사망)에서는 미보충(이슈 락은
   reapStalledIssueExecutionLocks 가 회수, 의도된 우아한 강등).
3. enqueueProcessLossRetry/enqueueAdapterFallbackRun 의 heartbeat.ts 밖 추출은 후속 리팩터 — 이번엔 단일 출처 유지 우선.

## 완료 조건과 증거

1. (a) 마킹: running→failed+shutdown_interrupted+CAS 충돌 스킵 테스트.
2. (b) 데드라인: 부분 스킵+로그, 총시간 상한 테스트.
3. (c) 회수 정합: 마킹+재시도 1회(이중 아님, envelope 세대 정합), 백스톱이 누락분 정확히 1회 보충 테스트.
4. (d) 체크포인트 스키마 불량 거부 테스트.
5. (e) 회귀: heartbeat-process-recovery, run-status-fencing, step-status-fencing, effect-envelope + 전체 test:run.
6. typecheck/build 통과, 출력 원문 보고.

## 이번에 하지 않을 것

enqueueProcessLossRetry/enqueueAdapterFallbackRun의 heartbeat.ts 밖 추출(리팩터 — 후속),
어댑터 CLI 자체 체크포인트, 승인대기 표지(④), lease 컬럼, UI, 플러그인 도구 멱등, heartbeat_runs 신규 컬럼/인덱스.
