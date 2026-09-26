# Effect Envelope — 비용·불가역 효과 이중 실행 방지 (로드맵 3/5)

Date: 2026-09-27
Branch: `insightflo/effect-envelope`
Status: 구현·검증 완료 (커밋 없음 — 워크트리 변경만)

## 최종 목표와 승인 범위

로드맵 확정 문구: "되돌릴 수 없거나 비용 있는 효과"만: 실행 전 intent 기록 + effect_id 멱등키,
깨움 outbox 감사 병행. 핵심 원칙: effect envelope는 비용/불가역성 기준 선별 — 전면 장부화 불필요.

이번 슬라이스: (1) 감사 분류표, (2) 표준 헬퍼(effect-envelope.ts) + (a)등급 최고위험에 적용,
(3) embedded PG 테스트, (4) 전체 검증. commit/push/merge/deploy 금지(워크트리 변경만).

## 선행 완료

- #276 지시 소비 커서(⑤), #277 런 상태 CAS(③-1), #278 스텝 상태 CAS(③-2). DB 내 상태 쓰기 펜싱 완료.

## 1단계 감사 분류 (2026-09-27 완료)

(a) = 비용+멱등 보호 없음 → 구현 대상, (b) = 비용+기존 보호 존재 → 감사만, (c) = 가역/저비용 → 제외.

| # | 지점 | 효과 | 기존 보호 | 분류 |
|---|---|---|---|---|
| 1 | `server/src/services/heartbeat.ts:7838` adapter.execute 경계 | 에이전트 실행(토큰 비용) | 같은 run 이중 실행은 #277 런 CAS로 펜싱됨. 그러나 **런 간** 중복 디스패치(이중 깨움, 코멘트-멘션 우회 경쟁, applied 후 중복 디스패치)는 미보호 | **(a) → 구현** |
| 2 | 깨움 outbox `agent_wakeup_requests` claim/coalesce | 런 디스패치 | 이슈 행 `for update` 직렬화 + coalesce/deferred 병합 + 승격 시 `queued`+`runId null` 재검사(:6166). 각주: 코멘트-멘션 우회(:10159)는 락 우회 + 선택-후-행동 경쟁 → 2런 동시 생성 가능(#1 엔벨로프가 일반적으로 차단) | (b) |
| 3 | 프로세스 손실/일시 어댑터 실패 재시도 대기열(`enqueueProcessLossRetry`) | 재실행 | reaper CAS 종결 + 정확히 1회 제한 재시도(`processLossRetryCount<1`), 테스트 존재 | (b) |
| 4 | `workflow/dag-engine.ts:4202` dispatchWorkflowChildStep | 자식 워크플로우 실행 | `claimChildInvocation` 원자 클레임(세대 항상 1), reused→대기 유지, start-lease 소유 | (b) |
| 5 | 이슈 없는 도구 스텝 디스패치(:2819)/완료(:3134) | 외부 도구 | `lastDispatchAcceptedAt IS NULL` 조건부 클레임 + requestId 세대 가드 | (b) |
| 6 | issue-create/update-side-effects → 깨움 | 에이전트 실행 | 깨움 중복 제거(#2와 동일) | (b) |
| 7 | SRB 아웃바운드 웹훅 | 외부 발행 | `srb_delivery_log` + 멱등 키 헤더 + 재시도 워커 클레임 | (b) |
| 8 | `routes/plugins.ts:1000` POST /plugins/tools/execute | 도구 실행(외부 효과) | 없음 — requestId는 서버 생성 fresh UUID(상관관계용). **호출자(에이전트) 안정 효과 키 계약 필요** — args 해시 자동 중복 제거는 의도적 재호출 오차별 위험 | **(a) → 후속 슬라이스** |
| 9 | plugin-tool-dispatcher `executeTool` worker RPC | 플러그인 외부 효과 | 없음(상태 비저장 전달) — #8과 동일한 호출자 키 의존 | **(a) → 후속** |
| 10 | 인바운드 플러그인 웹훅(:2050) externalId | 플러그인 내 외부 효과 | externalId 저장하지만 미검사 — 수신 영수증(유니크 제약) 필요 | **(a) → 후속** |
| 11 | 플러그인 잡 수동 트리거(:1993) | 잡 실행 | 없음(사람 트리거, 저빈도) | (a)-저위험 → 후속 |
| 12 | 플러그인 설치 / 워크트리·런타임 서비스 스폰 | 로컬 FS/프로세스 | 유니크 upsert / 재사용 키 | (c) |

구현 대상은 감사 결과 (a) 중 서버 파생 안정 키가 존재하는 유일한 최고위험 1곳(#1, 필수 포함
지점)으로 확정. #8/#9/#10/#11은 호출자 계약 또는 수신 영수증 패턴이 필요해 후속 표로 보고(과욕 금지 준수).

## 설계 (v2 — 전체 스위트 회귀로 발견한 구분 문제 반영)

v1(내용 기반 앵커만)은 같은 이슈/taskKey 의 순차적 의도적 재디스패치(코멘트 재런,
회복 브리프, 세션 회전 등 10개 기존 테스트)를 차단해 제품 흐름을 망가뜨렸다.
v2는 생성 시점 직렬화 서수로 “의도적 재디스패치”와 “동시 중복”을 구분한다:

- 신규 테이블 `effect_intents`(가산 마이그레이션 0114): effect_id 유니크 자연키,
  status intent|applied, attempt_run_id, anchor/generation/params 증빙 컬럼.
- 헬퍼 `server/src/services/effect-envelope.ts`(230줄):
  - effect_id = sha256(정규화 JSON of company + effect_kind + anchor + generation + params_hash)
  - anchor(논리 발주 정체성): agentId + (issueId|taskKey) + wakeReason + workflowRunId/stepId.
    앵커 없는 런(timer 깨움 등)은 런 고유 id 를 넣어 사실상 비펜스(오탐 원천 차단).
  - generation(공인 재시도 세대): processLossRetryCount + fallbackAttempt +
    workflowExecutionGeneration + **dispatchGeneration**(런 생성 트랜잭션 안에서
    `resolveNextDispatchGeneration` = 같은 앵커 기존 런 수 + 1 을 스탬프).
    순차 재디스패치 → 새 서수 → 실행. 동시 중복 → 커밋 전 관측으로 같은 서수 → 펜스.
  - params: adapterType + command + model + provider(세션 상태 제외).
  - 절차: INSERT ON CONFLICT DO NOTHING(intent) → attemptRunId·status 로 소유 판정 →
    소유면 실행 후 CAS(intent→applied) → 타 시도 소유 행이면 skipped_replay.
- 런 생성 6개 지점에 dispatchGeneration 스탬프: enqueueWakeup 본체(tx), 비잠금 enqueue 경로(db),
  promoteQueuedWakeupRequest, deferred 승격, process-loss 재시도, adapter fallback.
- heartbeat 배선(7917 부근): skipped_replay 시 `code: "fenced_effect_replay_skipped"` 예외 →
  기존 실패 정산으로 종결. 검증됨: 일시 재시도·fallback 큐잉 모두
  `errorCode === "adapter_failed"` 조건 → fenced 코드는 자동 재시도·폴백 억제.

잔여 한계(보고용):
1. 비잠금 enqueue 경로(6곳 중 db 핸들 1곳)의 count→insert 사이 창이 밀리초 단위로
   존재 — 순차 재디스패치가 극히 드물게 펜스될 수 있음(가시적 errorCode, 재디스패치로 회복).
2. 코멘트-멘션 우회 경쟁(heartbeat.ts:10159 bypassIssueExecutionLock)은 이슈 행 락을
   건너뛴다 — 엔벨로프가 동시 형태는 차단하지만 교차-커밋 교착은 확률적. 본 수리(우회 경로에
   동일 FOR UPDATE 적용)는 별도 슬라이스 권장.
3. applied 이후 도착하는 순차 중복(원천 디스패치가 새 결정으로 보임)은 v2 세대 모델에서
   실행된다 — 깨움 계층 coalesce 가 1차 방어(감사 (b) 판정), 엔벨로프는 동시 형태의 2차 방어.

## 완료 조건과 증거 (2026-09-27 전부 충족)

1. 감사 표 — 본 문서(완료). 깨움 outbox (b) 판정 근거: heartbeat.ts:6166/10177/10350-10581 +
   기존 테스트(wakeup-coalesced-requeue, heartbeat-process-recovery:475/633).
2. 구현 — `effect_intents` 스키마 + 마이그레이션 0114(db:generate, 순수 가산),
   `effect-envelope.ts`(230줄), heartbeat 배선(생성 6곳 스탬프 + 경계 펜스).
3. 테스트 — 단위 6건(a/b/c/세대/동시), 통합 4건(첫 실행+장부, 순차 재디스패치 실행
   회귀 가드, 쌍둥이 런 동시 형태 펜스, 별도 taskKey 실행). 전부 통과.
4. 검증 — `pnpm -r typecheck` exit 0 / `pnpm test:run` 913파일 6887통과+1skip /
   `pnpm build` exit 0. 대표 회귀(heartbeat-run-status-fencing, heartbeat-process-recovery,
   wakeup-coalesced-requeue) 30/30 통과 + 전체 스위트에 포함.

비고: `plan-qa-agent-api.test.ts` 는 server/ CWD 직접 실행 시 `scripts/quality/evidence.mjs`
경로가 해석 안 되어 실패(루트 CWD `pnpm test:run` 에서는 통과) — 본 변경 무관 환경 조건.

## 이번에 하지 않을 것

상태 테이블 추가 CAS(③ 완료), 체크포인트/SIGTERM flush(①), 승인대기 표지(④), lease 컬럼, UI,
agent_wakeup_requests 스키마 변경, #8-#11 후보 구현.
