# 2026-05-29 SkillOpt-lite self-improvement closeout handoff

작성 시각: 2026-05-29 23:29:54 KST +0900
작성 위치: `/Users/kwak/Projects/ai/papercompany/papercompany-runtime/doc/handoffs/2026-05-29-skillopt-lite-self-improvement-closeout-handoff.md`

## 0. 현재 판정

Papercompany agent 운영에 SkillOpt-lite식 자가개선 루프를 도입하는 작업은 아래 범위까지 완료됐다.

완료된 범위:

- Dynamic mission planning / SkillOpt-lite 운영 문서화
- runtime brief에 `selfImprovementCandidates` skeleton + contract 안내 반영
- mission owner plan decision에서 `selfImprovementCandidates` 구조화 저장
- malformed shape diagnostics
- candidate contract validation
- Mission Detail UI read-only 표시
- `rejectedEditNote` 정책 확정 및 검증
- adoption state / executor boundary 문서화
- 관련 변경 commit 완료

현재 판정:

```text
candidate 저장/검증/UI 표시/문서화/정책 확정까지 완료 + 커밋 완료.
실제 auto-adoption executor 구현은 다음 별도 slice로 남아 있음.
```

핵심 정책:

```text
evidence + bounded patch + validation gate
→ agent/peer gate PASS
→ 내부 asset 자동 채택
→ 사용자 승인 대기 없음
```

외부 side effect는 자동 채택 경로 밖이다.

```text
push / deploy / publish / credentials / destructive cleanup
```

## 1. Repo 상태

Runtime repo:

- 경로: `/Users/kwak/Projects/ai/papercompany/papercompany-runtime`
- branch: `main`
- 상태: `origin/main`보다 22 commits ahead
- handoff 작성 직전 상태: working tree clean

최근 관련 커밋:

```text
e654977 docs: define self-improvement adoption boundary
711d379 fix: require rejection notes for self-improvement candidates
0ceb056 feat: surface self-improvement candidates
```

Artifacts repo:

- 경로: `/Users/kwak/Projects/ai/papercompany/papercompany-artifacts`
- branch: `main`
- 상태: `origin/main`보다 3 commits ahead
- 기존 untracked plan docs가 남아 있음:

```text
?? doc/plans/2026-05-29-dynamic-mission-plan-operating-contract.md
?? doc/plans/2026-05-29-skillopt-lite-agent-self-improvement.md
```

주의:

- push는 하지 않았다.
- deploy는 하지 않았다.
- service restart는 하지 않았다.
- DB schema / route 변경은 없다.
- 실제 accepted candidate를 skill/rule/KB/workflow/role harness에 적용하는 executor는 구현하지 않았다.

## 2. 이번 세션에서 추가 완료된 작업

### 2.1 Mission Detail UI read-only 표시

커밋:

```text
0ceb056 feat: surface self-improvement candidates
```

주요 파일:

- `ui/src/pages/MissionDetail.tsx`
- `ui/src/pages/MissionDetail.test.tsx`

내용:

- Mission Detail 화면에서 `plan.refs.selfImprovementCandidates`를 read-only로 표시한다.
- 표시 필드는 운영자 확인에 필요한 요약 중심이다.
  - candidate count
  - `assetRef`
  - `assetType`
  - `autoAdoptionResult`
  - `proposedEdit.operation`
  - `proposedEdit.section`
  - `gateOwner`
  - `pattern`
- candidate 원문이나 임의 민감 body를 덤프하지 않는다.
- 테스트에 `sensitiveBody: "PRIVATE CANDIDATE BODY SHOULD NOT RENDER"`를 넣고 렌더되지 않음을 확인했다.

### 2.2 `rejectedEditNote` 정책 확정

커밋:

```text
711d379 fix: require rejection notes for self-improvement candidates
```

주요 파일:

- `server/src/services/mission-owner-plan-decisions.ts`
- `server/src/__tests__/mission-owner-plan-decisions.test.ts`
- `packages/adapter-utils/src/runtime-brief.ts`
- `server/src/__tests__/runtime-brief.test.ts`

정책:

```text
rejectedEditNote는 autoAdoptionResult === "rejected"일 때만 필수.
accepted / queued_for_validation / repair_needed 후보에는 필수 아님.
```

구현:

- rejected candidate에 `rejectedEditNote`가 없으면 `invalid_candidate_contract` diagnostic을 반환한다.
- queued candidate는 `rejectedEditNote` 없이도 통과한다.
- rejected candidate가 non-empty `rejectedEditNote`를 가지면 통과한다.
- runtime brief 문구도 동일 정책으로 갱신했다.

TDD 기록:

- RED: `requires rejectedEditNote only when self-improvement candidates are rejected` 테스트를 먼저 추가했고 기존 코드에서 실패 확인.
- GREEN: rejected-only validation 추가 후 focused test 통과.

### 2.3 Adoption state / executor boundary 문서화

커밋:

```text
e654977 docs: define self-improvement adoption boundary
```

주요 파일:

- `docs/guides/board-operator/mission-planning.md`

내용:

- candidate 저장과 Mission Detail 표시는 read-only surface임을 명시했다.
- 실제 asset patch는 별도 adoption executor runtime path로 분리해야 함을 명시했다.
- future executor boundary:
  1. `autoAdoptionResult: accepted` + current agent/peer gate PASS 후보만 선택
  2. `assetType` + `assetRef`로 정확히 하나의 내부 asset resolve
  3. bounded `proposedEdit`를 temporary patch target에 먼저 적용
  4. asset-specific validation plan 실행 및 diff/content readback
  5. adopted/rejected/repair diagnostics 기록 후 durable asset mutate
  6. push/deploy/publish/credentials/destructive cleanup/adapter reconfiguration 제외
- 이 executor는 candidate parsing, diagnostics, read-only UI와 독립적으로 구현/검증해야 한다.

## 3. 전체 관련 변경 파일

이번 closeout 기준 관련 변경/커밋에 포함된 파일:

```text
doc/handoffs/2026-05-29-skillopt-lite-self-improvement-handoff.md
docs/docs.json
docs/guides/agent-developer/task-workflow.md
docs/guides/agent-developer/writing-a-skill.md
docs/guides/board-operator/mission-planning.md
packages/adapter-utils/src/runtime-brief.ts
server/src/__tests__/mission-owner-plan-decisions.test.ts
server/src/__tests__/runtime-brief.test.ts
server/src/services/mission-owner-plan-decisions.ts
ui/src/pages/MissionDetail.test.tsx
ui/src/pages/MissionDetail.tsx
```

이번 handoff 파일 자체:

```text
doc/handoffs/2026-05-29-skillopt-lite-self-improvement-closeout-handoff.md
```

## 4. 검증 기록

### 4.1 UI slice 검증

```sh
NODE_ENV=test pnpm exec vitest run ui/src/pages/MissionDetail.test.tsx
pnpm --filter @paperclipai/ui typecheck
pnpm -r typecheck
pnpm test:run
pnpm build
```

결과:

- MissionDetail focused test 통과
- UI typecheck 통과
- repo typecheck 통과
- full test 통과
- build 통과

### 4.2 Rejected-note policy 검증

Focused commands:

```sh
NODE_ENV=test pnpm exec vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts -t "requires rejectedEditNote"
NODE_ENV=test pnpm exec vitest run server/src/__tests__/runtime-brief.test.ts
NODE_ENV=test pnpm exec vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts server/src/__tests__/runtime-brief.test.ts
pnpm -r typecheck
```

결과:

- focused tests 통과
- runtime brief test 통과
- combined server tests 통과
- typecheck 통과

### 4.3 Full verification

주의:

- shell 기본 `node`가 `v25.8.1 / ABI 141`이라 처음 `pnpm test:run`에서 `re2` ABI mismatch가 났다.
- 프로젝트 정상 경로는 Node v24 계열이다.
- 재실행 시 아래처럼 PATH를 고정했다.

```sh
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm test:run
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm build
```

최종 결과:

```text
pnpm test:run
→ 210 files passed
→ 1154 passed | 1 skipped

pnpm build
→ exit 0
```

기존성 warning:

- Vite `node:fs externalized for browser compatibility`
- Vite chunk size warning

둘 다 build exit code 0이며 이번 변경으로 새로 도입한 실패는 아니다.

### 4.4 Docs boundary verification

```sh
python3 - <<'PY'
from pathlib import Path
p = Path('docs/guides/board-operator/mission-planning.md')
text = p.read_text()
required = [
  'Rejected-edit note: <required when Auto-adoption result is rejected; optional otherwise>',
  '### Adoption state and executor boundary',
  'Candidate storage and Mission Detail display are read-only surfaces.',
  'Select only candidates with `autoAdoptionResult: accepted`',
  'Keep external side effects out of scope: no push, deploy, publish, credential changes, destructive cleanup, or adapter reconfiguration.',
]
missing = [s for s in required if s not in text]
if missing:
    raise SystemExit('missing required docs text: ' + repr(missing))
print('mission-planning adoption boundary docs: ok')
PY
```

결과:

```text
mission-planning adoption boundary docs: ok
```

## 5. Hermes skill 갱신

Hermes skill도 현재 정책에 맞게 갱신했다.

Skill:

```text
papercompany-self-improvement-operations
```

패치 내용:

```text
rejectedEditNote is required only when autoAdoptionResult is rejected;
queued/accepted/repair-needed candidates do not need it.
```

이것은 project repo commit에는 포함되지 않는 Hermes profile skill 변경이다.

## 6. 남은 작업

### 6.1 다음 자연스러운 implementation slice

다음 slice는 실제 accepted candidate를 내부 asset에 적용하는 **auto-adoption executor 설계/구현**이다.

단, 이건 side effect가 있는 runtime path이므로 바로 broad 구현하지 말고 더 작게 쪼개야 한다.

추천 첫 slice:

```text
accepted candidate를 실제 asset에 적용하지 않고,
executor가 어떤 candidate를 선택/거절할지 dry-run plan으로 산출하는 adoption planner 구현
```

권장 범위:

- 입력: `selfImprovementCandidates`
- 출력: `adoptionPlan[]` 또는 diagnostics
- durable asset mutation 없음
- push/deploy/publish/credentials/destructive cleanup 없음
- tests first

초기 acceptance criteria:

- accepted + gate PASS candidate만 selectable
- rejected/queued/repair_needed candidate는 apply 대상 제외
- unknown `assetType` / unresolved `assetRef`는 fail closed
- multi-asset patch 시도는 diagnostic
- plan result가 어떤 asset, 어떤 operation, 어떤 validationPlan을 실행할지 명확히 표시

### 6.2 이후 slice 후보

1. dry-run planner UI/diagnostic 노출
2. asset-specific temporary patch target 설계
3. validationPlan executor 인터페이스
4. durable internal asset patch 적용
5. post-adoption audit/activity 기록
6. slow/meta review queue 설계

## 7. 하지 않은 것 / 금지선

하지 않음:

- push
- deploy
- publish
- service restart
- DB schema 변경
- route 변경
- workflow run
- automatic optimizer runtime 실행
- accepted candidate 실제 asset patch

다음 세션에서도 명시 승인 전 피할 것:

- 외부 side effect
- `git add .`
- broad cleanup
- credentials / config secret 변경
- adapter reconfiguration

## 8. 다음 세션 시작 지침

추천 시작 문구:

```text
handoff 읽고 SkillOpt-lite auto-adoption executor의 dry-run planner slice부터 진행해줘. push/deploy 없이 tests-first로 해.
```

다음 세션에서 먼저 읽을 파일:

1. `doc/handoffs/2026-05-29-skillopt-lite-self-improvement-closeout-handoff.md`
2. `docs/guides/board-operator/mission-planning.md`
3. `packages/adapter-utils/src/runtime-brief.ts`
4. `server/src/services/mission-owner-plan-decisions.ts`
5. `server/src/__tests__/mission-owner-plan-decisions.test.ts`
6. `ui/src/pages/MissionDetail.tsx`
7. `ui/src/pages/MissionDetail.test.tsx`

다음 세션 시작 전 확인할 commands:

```sh
git status --short --branch
git log --oneline -5
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH node -p "process.version + ' ABI ' + process.versions.modules"
```
