# Handoff — Mission Operating Kernel Refactor

작성시각: 2026-06-04 KST
작성자: Hermes
대상 repo: `/Users/kwak/Projects/ai/papercompany/papercompany-runtime`
기준 브랜치/HEAD: `main` @ `b7c4a15`

## 0. 목적

Papercompany 미션 실행을 기존 heartbeat-run 중심 구조에서 **mission-scoped runtime / handoff / rolling state** 기반 구조로 옮기는 리팩터를 정리한다.

핵심 문제의식:

- issue heartbeat마다 CLI를 새로 띄우는 토큰 낭비를 줄인다.
- mission 단위로 context와 runtime을 격리한다.
- issue별 handoff와 mission rolling state를 남겨 compaction 이후에도 이어받을 수 있게 한다.
- recovery는 작은 고정 vocabulary로 제한하고, 특수 사례는 plugin/recipe 쪽으로 밀어낸다.

설계 기준 문서:

- `doc/spec/mission-operating-kernel.md`

## 1. 주요 변경 범위

### DB / schema

신규 테이블:

- `mission_agent_runtimes`
- `mission_issue_handoffs`
- `mission_rolling_state`

관련 파일:

- `packages/db/src/schema/mission_agent_runtimes.ts`
- `packages/db/src/schema/mission_issue_handoffs.ts`
- `packages/db/src/schema/mission_rolling_state.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/0055_mission_agent_runtime_state.sql`

확인 사항:

- 모두 `company_id`를 가진다.
- mission/agent/run/issue FK가 설정되어 있다.
- runtime uniqueness는 `(mission_id, agent_id, adapter_type, workspace_key)` 기준이다.

### Server kernel modules

신규/분리된 주요 모듈:

```text
server/src/services/missions/
├── mission-context-compiler.ts
├── mission-issue-envelope.ts
├── mission-owner-recovery-comments.ts
├── mission-owner-recovery-events.ts
├── mission-owner-recovery-explanations.ts
├── mission-owner-recovery-governance-format.ts
├── mission-recovery-policy.ts
├── mission-runtime-manager.ts
└── mission-supervision-context.ts
```

핵심 역할:

- `mission-runtime-manager.ts`: mission-agent runtime row lifecycle, runtime key, bootstrap marker, handoff/rolling state helpers, stop runtime
- `mission-context-compiler.ts`: persistent mission runtime 여부와 runtime context contract
- `mission-issue-envelope.ts`: child issue prompt envelope
- `mission-recovery-policy.ts`: bounded recovery vocabulary
- `mission-owner-recovery-*`: owner decision marker/comment/explanation/governance formatting
- `mission-supervision-context.ts`: supervision에 필요한 mission issue/comment context 수집

### Runtime / adapter / heartbeat 연결

수정된 주요 파일:

- `server/src/services/heartbeat.ts`
- `server/src/services/heartbeat-scheduler.ts`
- `server/src/services/issues.ts`
- `server/src/services/missions.ts`
- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/adapters/registry.ts`
- `server/src/adapters/hermes-local-execute.ts`
- `packages/adapter-utils/src/runtime-brief.ts`
- `packages/adapter-utils/src/server-utils.ts`

의도:

- persistent mission runtime을 지원하는 adapter는 bootstrap 이후 issue envelope 중심으로 실행한다.
- terminal/paused mission에는 runtime work enqueue를 막는다.
- mission terminal cleanup 시 runtime/session/issue 상태를 정리한다.

## 2. 최종 리뷰에서 발견하고 처리한 사항

최종 architecture review에서 runtime lifecycle guard 쪽 문제가 발견되어 수정했다.

### 수정 완료

1. **Mission terminal status 정의 정리**
   - `TERMINAL_MISSION_STATUSES`는 실제 `MissionStatus` type에 맞게 `completed`, `cancelled`만 유지.
   - runtime work 차단용으로 `MISSION_RUNTIME_WORK_BLOCKING_STATUSES`를 별도 도입.

2. **Paused mission work 차단**
   - `MISSION_RUNTIME_WORK_BLOCKING_STATUSES = completed | cancelled | paused`
   - `assertMissionRuntimeAcceptsWork()`가 paused도 reject한다.

3. **ensureMissionAgentRuntime 내부 guard 추가**
   - call site가 guard를 깜빡해도 terminal/paused mission runtime row를 만들지 못하게 했다.

4. **회귀 테스트 추가**
   - `server/src/__tests__/mission-runtime-manager.test.ts`
   - paused mission work reject
   - completed mission에서 `ensureMissionAgentRuntime()` 호출 시 runtime row가 생성되지 않음

### 남은 caveat / 후속 후보

아래는 이번 handoff의 blocker로 처리하지 않고, 후속 cleanup 후보로 남긴다.

1. `missions.ts` 안에 dogfood-specific artifact validator retry evidence 문자열이 아직 있다.
   - core에 오래 둘수록 spec의 plugin/recipe 분리 원칙과 충돌할 수 있다.
   - 후속 slice에서 strategy/plugin 쪽으로 빼는 것이 좋다.

2. `selectDefaultRecoveryAction()`은 policy module에 있지만 supervision path의 실제 decision engine으로 완전히 연결되어 있지는 않다.
   - 현재 supervision은 owner escalation 중심이다.
   - 자동 적용을 늘릴 때 이 policy를 wiring해야 한다.

3. `buildOwnerActionExplanations()`는 owner-action issue별 source lookup을 순차 수행한다.
   - 일반 cardinality는 낮아 보이나, 대량 unblock issue 상황에서는 batch query로 개선 여지가 있다.

4. Drizzle migration journal/snapshot drift
   - `pnpm db:generate` 실행 시 기존 journal/snapshot drift 때문에 중복 `0046_complete_pepper_potts.sql`가 생성된 적이 있다.
   - 중복 파일은 삭제하고 `_journal.json`은 복원했다.
   - 장기적으로 migration meta 관리 전략 점검이 필요하다.

## 3. Cleanup 결과

임시/무관 파일은 삭제하지 않고 sibling artifacts로 격리했다.

격리 위치:

```text
../papercompany-artifacts/tmp/papercompany-runtime-cleanup-20260604-132010
```

격리한 항목:

```text
list-routines.ts
list-runs.ts
list-tech-workflows.ts
list-workflows.ts
outputs/
.hermes/
server/dossier_lee_hakin.md
server/seoul_edu_candidates_ai_claims.md
```

`.gitignore`에는 다음 local scratch 항목을 추가했다.

```gitignore
/.hermes/
/outputs/
/working.md
```

`working.md`는 로컬 진행 ledger로 유지하되 commit 대상에서는 제외한다.

## 4. 검증 결과

### 완료된 검증

```sh
pnpm -r typecheck
pnpm build
pnpm test:run
```

결과:

- `pnpm -r typecheck`: exit 0
- `pnpm build`: exit 0, 기존 Vite chunk size warning만 있음
- `pnpm test:run`: exit 0

`pnpm test:run` 최종 통과 전 1차 실패가 있었다.

원인:

```text
re2.node compiled for NODE_MODULE_VERSION 141
active Node v24.13.0 requires NODE_MODULE_VERSION 137
```

조치:

```sh
rm -rf node_modules/.pnpm/re2@*/node_modules/re2/build server/node_modules/re2/build
npm_config_build_from_source=true pnpm --filter @paperclipai/server rebuild re2
```

그 후 full suite가 통과했다.

### 최종 리뷰 후 추가 검증

runtime guard 수정 후 targeted test를 먼저 실행했다.

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/mission-runtime-manager.test.ts
```

결과:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

그 뒤 최종 제출 전 전체 검증도 재실행했다.

```sh
pnpm -r typecheck
pnpm build
pnpm dlx prettier --check doc/handoffs/2026-06-04-mission-operating-kernel-refactor-handoff.md doc/spec/mission-operating-kernel.md doc/PRODUCT.md
pnpm test:run
```

결과:

```text
pnpm -r typecheck: exit 0
pnpm build: exit 0
prettier --check: exit 0
pnpm test:run: Test Files 222 passed (222); Tests 1240 passed | 1 skipped (1241); Duration 58.28s
```

## 5. 제출 전 체크리스트

- [x] runtime guard 수정 이후 `pnpm -r typecheck` 재실행
- [x] runtime guard 수정 이후 `pnpm build` 재실행
- [x] runtime guard 수정 이후 `pnpm test:run` 재실행
- [x] `doc/handoffs/2026-06-04-mission-operating-kernel-refactor-handoff.md` 작성
- [ ] `doc/handoffs/2026-06-03-research-mission-issue-explosion-handoff.md`를 같은 PR에 포함할지 별도 기록으로 분리할지 결정
- [ ] migration journal drift caveat를 PR 본문에 명시
- [ ] dogfood-specific artifact validator retry branch를 후속 cleanup issue로 남길지 결정

## 6. 현재 판단

현재 diff는 큰 편이지만, final scope review 기준으로 Mission Operating Kernel 범위 안에 들어간다.

구현, cleanup, 최종 리뷰, 핸드오프, 전체 검증은 완료됐다. 남은 것은 코드 수정이 아니라 PR/커밋 범위 결정이다.
