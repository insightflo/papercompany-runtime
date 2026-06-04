# Handoff — Research Company 서울교육감 리서치 미션 이슈 폭증 / 진행 실패

작성시각: 2026-06-03 20:28 KST
작성자: Hermes
대상 repo: `/Users/kwak/Projects/ai/papercompany/papercompany-runtime`
런타임: local Papercompany API `http://127.0.0.1:3200/api`

## 0. 이 문서의 목적

아침에 Research Company에 맡긴 리서치 미션이 하위 이슈를 100개 이상 생성했지만 최종 산출물까지 진행되지 않았다. 다음 에이전트가 이어받을 수 있도록 다음을 정리한다.

- 사고/오류 현황
- 확인된 근거와 로그
- 이미 구현/수정된 코드 내용
- 다음 에이전트가 해야 할 우선순위
- 건드리면 안 되는 경계

핵심 결론:

> 미션은 `paused`인데, 실제 실행계획 step/unit이 비어 있거나 안정적으로 고정되지 않은 상태에서 에이전트들이 자율적으로 child issue / unblock / recovery issue를 계속 만들었다. source 산출물이 없는 상태에서 QA와 검증 이슈가 먼저 열렸고, timeout/process_lost 복구가 같은 이슈 재시작보다 새 이슈 생성 쪽으로 기울면서 보드가 폭증했다.

## 1. 대상 미션

Company: Research Company
Company ID: `e7e3e98c-e720-4ddb-8f8b-36dd75805cc3`

Mission ID: `a9e22e26-ee12-41ee-8f19-b9b7a02174b1`
Mission title: `2026 서울시교육감 후보 공약·정치성향·과거 발언 분석 HTML 보고서`
Mission status: `paused`
Mission createdAt: `2026-06-03T01:58:16.652Z`
Mission updatedAt: `2026-06-03T10:59:09.684Z`

요청 산출물:

- `/Users/kwak/Downloads/seoul-education-superintendent-2026-analysis.html`
- 후보별 공약/정치성향/역사교육·뉴라이트/학생인권·교권/AI·학력·사교육·돌봄/과거 발언 근거 기반 분석
- 출처 기반 한국어 HTML 보고서

주의: 사용자가 명시적으로 “Hermes가 직접 산출물을 작성하지 말고 Research Company 팀이 child issue tree로 수행”하도록 한 미션이다. Hermes/다음 에이전트는 산출물 직접 대필보다 제어/복구/검증/핸드오프에 집중해야 한다.

## 2. 현재 사고 현황 요약

이전 진단 스냅샷 기준:

- 미션 연결 이슈: `239개`
- done: `104개`
- 열린 상태(todo/in_progress/blocked 등): `132개`
- unblock 보조 이슈: `68개`
- RES-436 run: `21b7846e-860d-47ba-8d7c-4003cfa38389`
- RES-436 실패: `Error: timed out waiting for response`

현재 API 관찰상 Research Company 전체 issue identifier는 `RES-447`까지 증가했다. 단, `/api/companies/{companyId}/issues?missionId=...` 호출은 모든 company issue를 반환하는 것으로 보이므로, 이 엔드포인트 결과의 총 개수 `447`을 곧바로 해당 미션 총량으로 쓰면 안 된다. 정확한 미션별 집계는 응답을 `missionId === a9e22e26-ee12-41ee-8f19-b9b7a02174b1`로 client-side 필터링하거나 DB에서 직접 필터링해야 한다.

현재 런타임 확인:

```text
GET http://127.0.0.1:3200/api/health
{"status":"ok","version":"0.3.1","deploymentMode":"local_trusted","deploymentExposure":"private","authReady":true,"bootstrapStatus":"ready","bootstrapInviteActive":false,"features":{"companyDeletionEnabled":true}}

LISTEN:
- node PID 56881: 127.0.0.1:3200, 127.0.0.1:13200
- postgres PID 56913: 127.0.0.1:54330 / [::1]:54330
```

## 3. 대표 실패 이슈 — RES-436

Issue ID: `b253b105-21c5-496d-89cb-3cd235dae760`
Identifier: `RES-436`
Title: `[Scout] Official budget docs for 방과후/돌봄 — candidate sources`
Status: `in_progress`
Assignee: Research Scout `d17173f5-0464-42f8-91fb-fe0a768666e6`
Checkout run: `21b7846e-860d-47ba-8d7c-4003cfa38389`
CreatedAt: `2026-06-03T10:41:05.462Z`
UpdatedAt: `2026-06-03T10:42:40.559Z`

Description:

```text
Locate primary ministry/agency budget documents and official statistics portals for 방과후 and 돌봄. Return only candidate source URLs, publication dates, and exact numeric figures/table headings, clearly flagged as leads. Exclude commentary and summary articles.
```

Ancestor chain observed:

- RES-333 `Source pack: official budget figures for 방과후/돌봄 — source discovery`
- RES-304 `Source pack: official budget figures for 방과후/돌봄`
- RES-295 `Source pack: official statistics and budget figures`
- RES-217 `[Research] Source pack: 사교육비·학원 규제 1차 출처 수집`

Run log path:

```text
/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/data/run-logs/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3/d17173f5-0464-42f8-91fb-fe0a768666e6/21b7846e-860d-47ba-8d7c-4003cfa38389.ndjson
```

Relevant log excerpt:

```text
2026-06-03T10:41:05Z fallback workspace used
2026-06-03T10:41:12Z agent reads paperclip skill instructions
2026-06-03T10:41:22Z checks PAPERCLIP_* env vars
2026-06-03T10:41:24Z queries compact inbox
2026-06-03T10:41:27Z fetches heartbeat context for RES-436
2026-06-03T10:41:29Z checks out RES-436 as in_progress
2026-06-03T10:41:34Z starts web search for 방과후/돌봄 budget docs
2026-06-03T10:41:43Z searches 지방교육재정알리미
2026-06-03T10:41:50Z searches moe.go.kr budget docs
2026-06-03T10:41:57Z searches 복지부 돌봄센터/지역아동센터 budget
2026-06-03T10:42:01Z searches 여가부 청소년방과후아카데미
2026-06-03T10:42:09Z searches 서울시교육청 budget
2026-06-03T10:42:31Z attempts to write scout leads to temp markdown
2026-06-03T10:42:40Z Error: timed out waiting for response
```

Interpretation:

- RES-436은 “지시를 못 받은” 케이스가 아니라 실제 웹 검색과 자료 수집을 시작했다.
- 하지만 scout 범위가 넓고 Antigravity/adapter 응답 timeout이 짧아, 산출물 comment를 남기기 전에 실패했다.
- 실패 후 issue 상태가 `in_progress`에 남아 회수되지 않았다.
- 이 패턴은 같은 이슈 재시작/회수가 아니라 unblock/recovery child issue 생성을 부르며 폭증을 키운다.

## 4. 폭증 원인 분류

### 4.1 최상위 원인 — active plan이 비어 있거나 실행 단위가 고정되지 않음

이전 API 스냅샷에서 active mission plan은 있었지만 다음 값이 확인됐다.

```text
activeMissionPlan: status active
stepCount: 0
executionUnitCount: 0
blockedOrFailedUnitCount: 0
```

즉 “계획이 있다”는 플래그는 있었지만 에이전트가 따를 실제 step/unit이 없었다. 그래서 director/worker가 각자 child issue를 만들어 흐름을 구성하려 했고, 중앙 제어가 약해졌다.

### 4.2 child issue 생성 상한/승격 기준 부족

후보 수 × 쟁점 수 × source/review/synthesis/recovery 조합이 곱해졌다. 특히 다음 originKind 계열이 폭증에 관여했다.

- `manual`
- `research_company_child_issue`
- `research_subtask`
- `mission_main_executor_unblock`
- `mission_owner_replan_recovery`

### 4.3 source 산출물 없이 QA/review가 먼저 열림

여러 QA issue가 “검증할 원천 테이블/산출물이 없다”는 이유로 blocked가 됐다. QA가 잘못한 게 아니라 source pack이 먼저 닫히지 않은 상태에서 validation gate가 열렸다.

### 4.4 timeout/process_lost 복구가 새 이슈 생성 쪽으로 기울어짐

실패한 source issue는 우선 같은 assignee + 같은 issue wakeup으로 이어져야 한다. 하지만 실제 흐름에서는 `[Unblock] RES-...`, `[Recovery][Research] ... shard`, `[Review] ...` 등이 계속 생성됐다.

### 4.5 실행 어댑터와 prompt 전달 불안정

Research Scout 계열은 Antigravity 로컬 어댑터를 사용한다. RES-436은 `Error: timed out waiting for response`로 실패했다. 또한 custom promptTemplate이 `{{taskBody}}`를 포함하지 않는 경우 실제 assigned issue 내용이 prompt에 충분히 붙지 않을 수 있는 문제가 확인되어 패치가 들어갔다.

## 5. 이미 생성된 진단 산출물

초보자용 HTML 진단 문서:

```text
/Users/kwak/Downloads/research-mission-issue-explosion-root-cause.html
```

원본 작업본:

```text
/Users/kwak/Projects/ai/papercompany/papercompany-runtime/outputs/research-mission-issue-explosion-root-cause.html
```

해당 HTML의 핵심 결론:

> 미션은 active였는데, 실제 실행 계획 step/unit이 비어 있어서 agent들이 각자 하위 이슈를 계속 만들었고, source 산출물이 없는 상태에서 QA/검증/언블록 루프가 먼저 돌아 이슈가 폭증했다.

## 6. repo 상태 / 구현 내용

Git 상태:

```text
branch: main...origin/main [ahead 25]
working tree: dirty
```

Diff stat:

```text
36 files changed, 2509 insertions(+), 111 deletions(-)
```

Untracked:

```text
.hermes/
list-routines.ts
list-runs.ts
list-tech-workflows.ts
list-workflows.ts
outputs/
server/src/__tests__/plugin-tool-execute-projectless.test.ts
```

### 6.1 Dynamic owner-plan / workflow launchability guard

Files:

- `packages/plugins/workflow-engine/src/dag-engine.ts`
- `packages/plugins/workflow-engine/src/worker.ts`
- `packages/plugins/workflow-engine/tests/dynamic-owner-plan-dag.test.mjs`

Implemented:

- `validateWorkflowLaunchability()` 추가.
- normal step이 없거나 activatable root step이 없으면 workflow start 전에 error.
- dynamic owner-plan workflow의 launch step 계산을 명시화.
- `startWorkflow()`에서 launchability assertion 추가.

Purpose:

- plan step 삭제/빈 DAG/rootless workflow가 조용히 실행되어 `activatedStepIds=[]`가 되는 문제를 fail-closed로 막기.

### 6.2 Assigned issue prompt/context 강화

Files:

- `server/src/services/heartbeat.ts`
- 관련 tests: `server/src/__tests__/heartbeat-context-budget-preflight.test.ts`, `server/src/__tests__/runtime-brief.test.ts`, etc.

Implemented:

- issue assignment wake 시 promptTemplate이 `{{taskBody}}`/task section을 포함하지 않으면 `## Assigned Task` 섹션을 뒤에 붙인다.
- task id/title/body를 adapter config에 주입한다.
- local agent env에 `PAPERCLIP_API_KEY`를 주입한다.
- issue recent comments 최근 5개를 heartbeat context에 포함한다.
- mission issue인데 maintenance guidance가 없으면 generic maintenance decision context를 억제한다.
- session reset reason에 `mission_unblock_action_created`, `mission_unblock_action_stalled` 추가.

Purpose:

- agent가 역할 설명만 수행하고 실제 issue를 놓치는 문제 방지.
- “라이프사이클 도구가 없다”고 착각하지 않도록 API env와 issue id를 명확히 제공.

### 6.3 Mission owner retry / stale source wakeup 경로

Files:

- `server/src/services/missions.ts`
- `server/src/routes/missions.ts`
- `server/src/services/mission-owner-supervision-monitor.ts`
- tests: `server/src/__tests__/missions-service.test.ts`, `mission-owner-supervision-monitor.test.ts`

Implemented:

- owner decision이 `retry_source_issue`인 경우 source issue wakeup dispatch 경로 추가.
- stale source issue wakeup marker/comment 추가.
- failed/error terminal run을 새 child issue보다 source issue wakeup으로 처리하는 action 타입 추가.
- `dispatchOwnerDecisionWakeups`, `dispatchStaleSourceIssueWakeups`, `applyOwnerDecisionActions` 옵션 추가.
- governance evidence를 owner unblock description에 포함.
- validator retry evidence comment builder 추가.

Purpose:

- blocked/failed source issue를 무조건 새 unblock/recovery issue로 만들지 않고 기존 issue를 다시 깨우는 경로 제공.

### 6.4 Issue parent mission inheritance / stale lock adoption

Files:

- `server/src/services/issues.ts`
- `packages/shared/src/validators/issue.ts`
- UI issue creation files: `ui/src/components/NewIssueDialog.tsx`, `ui/src/context/DialogContext.tsx`, `ui/src/pages/IssueDetail.tsx`

Implemented:

- child issue 생성 시 parent issue의 `missionId`를 상속.
- stale/missing heartbeat run이 있는 execution lock을 같은 assignee + actor run으로 adopt하는 경로 추가.
- malformed execution lock repair 시 `executionRunId`, `executionLockedAt`도 clear.
- issue validator에 신규 필드/상태 관련 변경 반영.

Purpose:

- child issue가 mission tree 밖으로 빠지는 것 방지.
- `in_progress`인데 checkoutRunId가 비어 있고 stale executionRunId만 남아 재시작이 막히는 케이스 복구.

### 6.5 Antigravity adapter 진단 강화

Files:

- `packages/adapters/antigravity-local/src/server/execute.ts`
- `packages/adapters/antigravity-local/src/server/execute.test.ts`

Implemented:

- `--log-file` diagnostic log path 주입.
- 기존 extraArgs에 `--log-file`이 있으면 중복 제거 후 새 log file 지정.
- diagnostic log를 읽어 `diagnosticLogExcerpt`로 result에 포함.
- `RESOURCE_EXHAUSTED (code 429)`를 `provider_quota_exhausted`로 분류.
- stdout/stderr 없이 종료되면 `Antigravity CLI exited without producing a response` 처리.
- latest response가 `Error: timed out waiting for response`이면 adapter failure로 명시.

Purpose:

- RES-436 같은 timeout이 뭉뚱그려지지 않게 원인과 diagnostic evidence 확보.

### 6.6 Research Workbench / Vane local backend fetch

Files:

- `packages/plugins/research-workbench/src/adapters/vane-headless.ts`
- `packages/plugins/research-workbench/src/worker.ts`
- `packages/plugins/research-workbench/tests/vane-headless-adapter.test.mjs`

Implemented:

- Vane-only direct fetch escape hatch 추가.
- `127.0.0.1`/`::1` local Vane backend에만 directFetch 사용.
- 전역 plugin HTTP SSRF guard를 풀지 않고 repo-local Vane headless backend만 접근 가능하게 함.

Purpose:

- research-workbench/Vane headless path가 local backend SSRF guard에 막히는 문제를 제한적으로 해결.

### 6.7 JWT secret fallback

File:

- `server/src/agent-auth-jwt.ts`

Implemented:

- `PAPERCLIP_AGENT_JWT_SECRET`이 process env에 없으면 Paperclip env file에서 읽는다.

Purpose:

- dev/runtime env 차이로 agent auth JWT secret이 누락되는 문제 완화.

### 6.8 Inbox badge noise reduction

Files:

- `ui/src/lib/inbox.ts`
- `ui/src/lib/inbox.test.ts`
- `ui/src/hooks/useInboxBadge.ts`
- `ui/src/pages/Inbox.tsx`
- `ui/src/pages/AgentDetail.tsx`

Implemented:

- heartbeat run context에서 issueId/taskId 추출.
- latest failed runs 중 이미 resolved issue(done/cancelled/completed)에 속한 실패는 inbox badge에서 제외.

Purpose:

- 이미 해결된 실패 run이 계속 알림으로 떠서 실제 문제를 가리는 노이즈 감소.

## 7. 검증 상태

이 handoff 작성 시점에는 full test/build를 새로 돌리지 않았다. 이전 세션 기록상 다음은 통과/확인됐다고 보고되어 있다.

- workflow-engine focused test: `43 pass`
- typecheck: exit `0`
- build: exit `0`
- full test: `1184 pass`, unrelated failure `1`
- commit `b7c4a15 Enable dynamic owner-plan workflows` 이후 working tree에 추가 dirty 변경 존재

다음 에이전트는 반드시 현재 dirty tree 기준으로 다시 실행해야 한다.

권장 검증 순서:

```sh
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm test:run packages/plugins/workflow-engine/tests/dynamic-owner-plan-dag.test.mjs
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm test:run server/src/__tests__/missions-service.test.ts
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm test:run server/src/__tests__/heartbeat-context-budget-preflight.test.ts
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm -r typecheck
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm test:run
PATH=/Users/kwak/.nvm/versions/node/v24.13.0/bin:$PATH pnpm build
```

## 8. 다음 에이전트 우선순위

### P0 — 더 이상 issue를 늘리지 말고 정지/격리 상태 확인

1. Research Company mission `a9e22e26-ee12-41ee-8f19-b9b7a02174b1`이 계속 자동 wakeup을 만들고 있는지 확인.
2. queued/running heartbeat run이 해당 mission issue를 계속 생성하는지 확인.
3. 필요하면 사용자 승인 후 mission supervision / scheduler / wakeup dispatch를 일시 정지한다.
4. 새 child issue 생성 금지. 복구는 기존 source issue wakeup 또는 명시적 bounded issue 1~3개만.

### P1 — 미션별 정확한 issue inventory 재집계

API caveat가 있다. `/companies/{companyId}/issues?missionId=...`가 모든 company issue를 반환할 수 있으므로 반드시 client-side filter 또는 DB query로 `missionId`를 필터링한다.

필요 집계:

- status별 count
- originKind별 count
- createdByAgentId별 count
- assigneeAgentId별 count
- open issue top 30
- blocked issue 중 source artifact 없음/QA 선행 케이스
- timeout/process_lost run과 연결된 issue

### P2 — 살릴 줄기 3개만 선택

추천 줄기:

1. 후보 finality / 후보자 공식 상태 source pack
2. 핵심 쟁점별 원문 source pack: 역사교육·뉴라이트 / 학생인권·교권 / AI·학력 / 사교육·돌봄
3. HTML synthesis + validator gate

나머지는 backlog/cancel/hidden 후보로 분류한다. 단, 실제 상태 변경은 사용자 승인 또는 명확한 operational gate 후 수행.

### P3 — RES-436 회수

RES-436은 comment 없이 timeout으로 끝났고 issue는 `in_progress`에 남았다. 다음 중 하나를 선택한다.

- 같은 Research Scout에게 bounded retry wakeup: “공식 source URL 후보 5개만, comment 작성 후 done”
- 더 안정적인 Hermes/local researcher로 reassignment 후 source candidate table만 작성
- 이미 다른 source issue가 같은 범위를 커버했다면 RES-436을 blocked/cancelled/done 중 적절히 정리

새 `[Unblock] RES-436` issue를 만들기보다 RES-436 자체의 상태/댓글/wakeup을 정리하는 것이 우선이다.

### P4 — 구현 diff 검증 및 축소

현재 dirty diff가 크다. 다음 에이전트는 구현을 기능군별로 쪼개 검증해야 한다.

1. workflow launchability guard
2. heartbeat assigned task prompt/env injection
3. mission owner retry/stale wakeup
4. issue mission inheritance/stale lock adoption
5. Antigravity diagnostics
6. Vane direct fetch
7. UI inbox filtering

각 기능군별 테스트를 먼저 통과시킨 뒤 full typecheck/test/build로 마무리한다.

## 9. 금지/주의

- 이 미션의 최종 HTML을 Hermes/다음 에이전트가 직접 “대충 작성”해서 끝내지 말 것. 미션 요구는 Research Company가 source-backed로 수행하는 것.
- 더 많은 child issue를 자동 생성하지 말 것.
- QA issue는 검증할 source artifact/comment/table이 있을 때만 열 것.
- timeout/process_lost는 새 issue 생성보다 기존 issue wakeup/retry/lock repair 우선.
- `git add .` 금지. dirty 파일이 많으므로 기능군별로 선별 staging 필요.
- push/deploy/publish 금지.
- 서버 재시작/DB 직접 수정/mission 상태 대량 변경은 사용자 승인 후.
- 전역 SSRF guard 해제 금지. Vane local direct fetch escape hatch만 허용.

## 10. 빠른 참조 명령

Health:

```sh
curl -sS http://127.0.0.1:3200/api/health
```

Research Company:

```sh
curl -sS http://127.0.0.1:3200/api/companies/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3
```

Mission list에서 대상 mission 찾기:

```sh
curl -sS http://127.0.0.1:3200/api/companies/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3/missions | jq '.[] | select(.id=="a9e22e26-ee12-41ee-8f19-b9b7a02174b1")'
```

RES-436:

```sh
curl -sS http://127.0.0.1:3200/api/issues/b253b105-21c5-496d-89cb-3cd235dae760 | jq
curl -sS http://127.0.0.1:3200/api/issues/b253b105-21c5-496d-89cb-3cd235dae760/comments | jq
```

RES-436 run log:

```sh
python3 - <<'PY'
from pathlib import Path
p = Path('/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/data/run-logs/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3/d17173f5-0464-42f8-91fb-fe0a768666e6/21b7846e-860d-47ba-8d7c-4003cfa38389.ndjson')
print(p.read_text())
PY
```

## 11. Recommended handoff prompt for next agent

```text
You are taking over Papercompany runtime incident recovery.

Read:
- /Users/kwak/Projects/ai/papercompany/papercompany-runtime/doc/handoffs/2026-06-03-research-mission-issue-explosion-handoff.md
- /Users/kwak/Projects/ai/papercompany/papercompany-runtime/outputs/research-mission-issue-explosion-root-cause.html

Mission:
- companyId `e7e3e98c-e720-4ddb-8f8b-36dd75805cc3`
- missionId `a9e22e26-ee12-41ee-8f19-b9b7a02174b1`

First objective:
1. Do not create new child issues.
2. Confirm whether automation is still spawning/waking issue runs.
3. Produce an exact mission issue inventory filtered by missionId.
4. Identify which 3 source/synthesis/validator branches should be kept.
5. Recommend, but do not execute without approval, any bulk cancellation/pausing/status repair.

Second objective:
Verify the dirty implementation changes by functional group. Do not use git add . Do not push/deploy.
```

## 12. Known typo traps

- Company ID is `e7e3e98c-e720-4ddb-8f8b-36dd75805cc3`.
- Mission ID is `a9e22e26-ee12-41ee-8f19-b9b7a02174b1`.
- RES-436 issue ID is `b253b105-21c5-496d-89cb-3cd235dae760`.
- RES-436 run ID is `21b7846e-860d-47ba-8d7c-4003cfa38389`.
- Do not confuse `d17173f5-0464-42f8-91fb-fe0a768666e6` Research Scout agent ID with company/mission IDs.
