# 2026-05-29 SkillOpt-lite self-improvement handoff

작성 시각: 2026-05-29 18:41:01 KST +0900
작성 위치: `/Users/kwak/Projects/ai/papercompany/papercompany-runtime/doc/handoffs/2026-05-29-skillopt-lite-self-improvement-handoff.md`

## 0. 현재 판정

이번 세션의 목표는 Papercompany agent 운영에 SkillOpt-lite식 자가개선 루프를 도입하되, RPA식 과강제나 사용자 승인 대기형 흐름이 아니라 **agent/peer-gated 자동 채택**으로 정리하는 것이었다.

현재 판정:

- 정책/문서 slice: 완료, peer PASS.
- `selfImprovementCandidates` 구조화 저장 slice: 완료, peer PASS.
- malformed shape diagnostics slice: 완료, peer PASS.
- candidate contract validation slice: 완료, peer PASS.
- commit/push/deploy: 하지 않음.
- DB schema/routes/UI/workflow runtime/automatic optimizer runtime: 건드리지 않음.

핵심 정책:

```text
evidence + bounded patch + validation gate
→ agent/peer gate PASS
→ 내부 asset 자동 채택
→ 사용자 승인 대기 없음
```

외부 side effect는 자동 채택 경로 밖:

```text
push / deploy / publish / credentials / destructive cleanup
```

## 1. 작업 디렉토리 / repo 상태

Runtime repo:

- `/Users/kwak/Projects/ai/papercompany/papercompany-runtime`
- branch: `main`
- 상태: `origin/main`보다 19 commits ahead
- 이번 handoff 작성 시점 dirty 범위:

```text
 M docs/docs.json
 M docs/guides/agent-developer/task-workflow.md
 M docs/guides/agent-developer/writing-a-skill.md
 M packages/adapter-utils/src/runtime-brief.ts
 M server/src/__tests__/mission-owner-plan-decisions.test.ts
 M server/src/__tests__/runtime-brief.test.ts
 M server/src/services/mission-owner-plan-decisions.ts
?? docs/guides/board-operator/mission-planning.md
?? doc/handoffs/2026-05-29-skillopt-lite-self-improvement-handoff.md
```

Runtime diff stat before handoff file:

```text
docs/docs.json                                     |   1 +
docs/guides/agent-developer/task-workflow.md       |  25 ++++
docs/guides/agent-developer/writing-a-skill.md     |  40 +++++
packages/adapter-utils/src/runtime-brief.ts        |  30 ++++
server/src/__tests__/mission-owner-plan-decisions.test.ts | 162 +++++++++++++++++++++
server/src/__tests__/runtime-brief.test.ts         |  25 ++++
server/src/services/mission-owner-plan-decisions.ts | 143 ++++++++++++++++++
```

Artifacts repo:

- `/Users/kwak/Projects/ai/papercompany/papercompany-artifacts`
- branch: `main`
- 상태: `origin/main`보다 3 commits ahead
- dirty 범위:

```text
?? doc/plans/2026-05-29-dynamic-mission-plan-operating-contract.md
?? doc/plans/2026-05-29-skillopt-lite-agent-self-improvement.md
```

## 2. 완료된 구현/문서 요약

### 2.1 Dynamic Mission Planning / SkillOpt-lite 운영 문서

주요 파일:

- `docs/docs.json`
- `docs/guides/board-operator/mission-planning.md`
- `docs/guides/agent-developer/task-workflow.md`
- `docs/guides/agent-developer/writing-a-skill.md`
- `../papercompany-artifacts/doc/plans/2026-05-29-dynamic-mission-plan-operating-contract.md`
- `../papercompany-artifacts/doc/plans/2026-05-29-skillopt-lite-agent-self-improvement.md`

핵심 내용:

- mission invariant → scope hypothesis → evidence → validator/gate → promotion 구조 정리.
- SkillOpt-lite를 Papercompany식 내부 asset 개선 루프로 해석.
- 개선 후보는 `evidence source`, `bounded add/delete/replace patch`, `validation plan`, `gate owner`, `auto-adoption result`를 가진다.
- 사용자 정정에 따라 사용자 승인 대기 없이 agent/peer validation gate로 자동 채택하도록 변경.
- rejected-edit 개념은 유지하되, broad rewrite / stale session artifacts / PR 번호 / issue 번호 / commit hash 같은 일회성 정보 승격은 금지.

### 2.2 Runtime brief 반영

파일:

- `packages/adapter-utils/src/runtime-brief.ts`
- `server/src/__tests__/runtime-brief.test.ts`

반영 내용:

- mission owner brief에 dynamic mission planning protocol 추가.
- `selfImprovementCandidates: []` skeleton 추가.
- SkillOpt-lite 문구를 사용자 승인 없는 agent/peer-gated 자동 채택으로 정정.
- candidate contract 안내 추가:

```text
assetType must be skill/rule/kb/workflow/role_harness;
proposedEdit.operation must be add/delete/replace;
autoAdoptionResult must be accepted/rejected/queued_for_validation/repair_needed;
required fields are assetType, assetRef, evidenceSource, pattern, proposedEdit, validationPlan, gateOwner, and autoAdoptionResult.
```

### 2.3 `selfImprovementCandidates` 구조화 저장

파일:

- `server/src/services/mission-owner-plan-decisions.ts`
- `server/src/__tests__/mission-owner-plan-decisions.test.ts`

동작:

- mission owner structured decision에서 `selfImprovementCandidates`를 읽는다.
- 정상 후보는 plan revision draft의 refs에 보존된다.

```ts
draft.refs.selfImprovementCandidates
```

### 2.4 malformed shape diagnostics

`selfImprovementCandidates`가 present일 때 아래를 진단한다.

```text
non-array value → invalid_field_shape
too-large array → array_too_large
non-object entry → invalid_entry_type
```

진단 발생 시 draft builder는 failure를 반환한다. 잘못된 후보가 조용히 omitted/accepted 되지 않는다.

### 2.5 candidate contract validation

각 candidate required fields:

```text
assetType
assetRef
evidenceSource
pattern
proposedEdit
validationPlan
gateOwner
autoAdoptionResult
```

허용 enum:

```text
assetType: skill | rule | kb | workflow | role_harness
proposedEdit.operation: add | delete | replace
autoAdoptionResult: accepted | rejected | queued_for_validation | repair_needed
```

추가 shape:

```text
evidenceSource: non-empty array, entries string/object
proposedEdit: object, operation string, section string
```

위반 시:

```text
invalid_candidate_contract
```

## 3. 검증 기록

실행한 focused/full commands:

```sh
pnpm vitest run server/src/__tests__/runtime-brief.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts -t "preserves self-improvement candidates"
pnpm vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts -t "self-improvement candidates"
pnpm vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts server/src/__tests__/runtime-brief.test.ts
pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/adapter-utils typecheck
```

최종 확인된 결과:

```text
pnpm vitest run server/src/__tests__/mission-owner-plan-decisions.test.ts server/src/__tests__/runtime-brief.test.ts
→ 2 files passed, 51 tests passed

pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/adapter-utils typecheck
→ exit 0
```

TDD 흐름:

- preservation RED: `refs.selfImprovementCandidates`가 없어서 실패.
- preservation GREEN: refs 보존 구현 후 통과.
- runtime brief RED: skeleton에 `"selfImprovementCandidates": []`가 없어서 실패.
- runtime brief GREEN: skeleton 추가 후 통과.
- malformed shape RED: non-object entry가 조용히 통과/omitted 가능.
- malformed shape GREEN: diagnostics 추가 후 통과.
- contract validation RED: missing required field / invalid enum 후보가 통과.
- contract validation GREEN: required field + enum validation 추가 후 통과.

## 4. Peer gate 기록

사용한 peer:

- `ls24unot`

받은 PASS:

1. SkillOpt-lite 정책/문서 slice PASS.
2. 사용자 승인 없는 최종 policy slice PASS.
3. `selfImprovementCandidates` structured preservation PASS.
4. preservation + malformed-shape diagnostics PASS.
5. candidate contract validation PASS.

최신 PASS 요약:

```text
PASS — selfImprovementCandidates candidate contract validation slice.
Required field coverage, enum coverage, evidenceSource/proposedEdit shape checks,
invalid_candidate_contract diagnostics, runtime brief contract line, tests all acceptable.
```

최신 non-blocking note:

```text
brief에는 rejected-edit note 개념이 남아 있지만 enforced required contract에는 rejectedEditNote를 필수로 요구하지 않는다.
현재 slice의 required-field list와 일치하므로 blocker 아님.
필요하면 다음 slice에서 rejectedEditNote mandatory contract로 올릴 수 있음.
```

## 5. 아직 하지 않은 것 / 다음 작업 후보

명시적으로 하지 않은 것:

```text
DB schema 변경
route/API 변경
UI 변경
service restart
workflow run
automatic optimizer runtime
accepted candidate 실제 asset patch 실행
commit
push
deploy
```

다음 자연스러운 slice 후보:

### A. Mission Detail UI 표시

목표:

- plan refs의 `selfImprovementCandidates`를 Mission Detail 또는 Plan/Decision surface에 표시.
- 상태별 시각화:
  - `accepted`
  - `rejected`
  - `queued_for_validation`
  - `repair_needed`
- 외부 side effect 없이 read-only UI 표시부터 시작.

권장 접근:

1. 현재 mission plan artifact API/serializer 확인.
2. UI에서 refs 접근 경로 확인.
3. 후보 카드/테이블 표시 테스트 추가.
4. 기존 mission detail tests 또는 component tests로 검증.

### B. `rejectedEditNote` mandatory 여부 결정/구현

목표:

- policy상 rejected-edit buffer를 더 강제할지 결정.
- mandatory로 올릴 경우 candidate contract에 `rejectedEditNote` required 추가.

주의:

- 모든 상태에서 반드시 필요한지, `rejected` 상태에서만 필요한지 결정해야 함.
- 지금 peer caveat는 non-blocking.

### C. adoption state/executor 설계

목표:

- `accepted` candidate가 실제 skill/rule/KB/workflow/role harness에 자동 patch되는 경로 설계.

주의:

- 이 단계부터는 runtime side effect가 생긴다.
- 사용자 정책상 내부 asset은 사용자 승인 없이 agent/peer gate로 자동 채택 가능하지만, push/deploy/publish/secrets/destructive cleanup은 계속 제외.
- 구현 전 scope를 작게 나눌 것:
  1. accepted candidate 조회/read model
  2. dry-run patch proposal
  3. agent/peer gate readback
  4. internal asset patch executor
  5. rejected-edit buffer persistence

## 6. 다음 세션 시작 지침

다음 세션에서 이어갈 때 먼저 읽을 파일:

1. 이 handoff:
   - `papercompany-runtime/doc/handoffs/2026-05-29-skillopt-lite-self-improvement-handoff.md`
2. Runtime 구현:
   - `papercompany-runtime/server/src/services/mission-owner-plan-decisions.ts`
   - `papercompany-runtime/server/src/__tests__/mission-owner-plan-decisions.test.ts`
   - `papercompany-runtime/packages/adapter-utils/src/runtime-brief.ts`
   - `papercompany-runtime/server/src/__tests__/runtime-brief.test.ts`
3. 문서/계획:
   - `papercompany-runtime/docs/guides/board-operator/mission-planning.md`
   - `papercompany-runtime/docs/guides/agent-developer/writing-a-skill.md`
   - `papercompany-artifacts/doc/plans/2026-05-29-skillopt-lite-agent-self-improvement.md`

추천 시작 문구:

```text
handoff 읽고 SkillOpt-lite selfImprovementCandidates 다음 slice 이어가. 우선 UI 표시 또는 rejectedEditNote mandatory 여부부터 확인해.
```

## 7. 주의사항

- 현재 worktree는 여러 PASSed slice가 누적 dirty 상태다. `git add .` 금지.
- 다음 작업도 explicit path staging만 사용할 것.
- commit/push/deploy는 사용자 지시 전 하지 말 것.
- peer PASS는 read-only gate였고, peer는 테스트/서비스 실행/DB mutation/commit/push/deploy를 하지 않았다.
- full repo 전체 테스트/빌드는 이번 handoff 직전에 다시 돌리지 않았다. 최종 fresh evidence는 focused files 51 tests + server/adapter-utils typecheck이다.
- Runtime server/Colima/SearXNG 등 기존 background 서비스가 남아 있을 수 있으나 이번 handoff 작성 작업에서는 서비스 조작을 하지 않았다.
