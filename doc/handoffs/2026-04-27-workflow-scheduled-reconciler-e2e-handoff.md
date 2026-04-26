# 2026-04-27 Workflow scheduled/reconciler E2E handoff

작성 시각: 2026-04-27 08:45:37 KST +0900
작성 위치: /Users/kwak/Projects/ai/papercompany/papercompany-runtime/doc/handoffs/2026-04-27-workflow-scheduled-reconciler-e2e-handoff.md

## 0. 현재 판정

최초 목적:
- workflow 실행
- mission 자동 생성
- workflow run이 mission에 연결
- Mission > Execution Flow 탭에 표시
- 실제 화면에서 확인

현재 판정:
- manual workflow run: 완료, 실제 브라우저 E2E 확인 완료.
- scheduled/reconciler workflow run: 완료, API + 실제 브라우저 E2E 확인 완료.
- full verification: 완료.

중요: 이전 handoff의 "scheduled/reconciler Mission Execution Flow 표시 실패" 상태는 해결됨.

## 1. 작업 디렉토리 / repo 상태

Runtime repo:
- /Users/kwak/Projects/ai/papercompany/papercompany-runtime
- branch: main
- HEAD: 6d53af7

Runtime repo 현재 dirty 범위:
- M server/src/__tests__/missions-service.test.ts
- M server/src/__tests__/workflow-dag-engine.test.ts
- M server/src/services/missions.ts
- M server/src/services/workflow/engine.ts
- ?? doc/handoffs/2026-04-27-workflow-scheduled-reconciler-e2e-handoff.md

Runtime diff stat:
- server/src/__tests__/missions-service.test.ts: +162
- server/src/__tests__/workflow-dag-engine.test.ts: +85
- server/src/services/missions.ts: +260 / - 일부
- server/src/services/workflow/engine.ts: +55 / - 일부

Plugin repo 주의:
- papercompany-runtime/packages/plugins/workflow-engine 경로는 외부 plugin repo /Users/kwak/Projects/paperclip/paperclip-addon/plugins/workflow-engine 쪽과 연결되어 있다.
- /Users/kwak/Projects/paperclip/paperclip-addon 는 작업 전부터 매우 dirty하다. 이번 작업과 무관한 변경이 많으므로 전체 repo 단위 커밋/정리는 위험하다.
- 이번 작업에서 확인/수정한 관련 plugin 파일만 범위 제한해서 다룰 것:
  - plugins/workflow-engine/src/worker.ts
  - plugins/workflow-engine/src/reconciler.ts
  - plugins/workflow-engine/dist/ui/index.js
  - plugins/workflow-engine/dist/ui/index.js.map
  - build 결과로 dist/worker.js, dist/reconciler.js 등도 dirty일 수 있음

## 2. 구현 요약

### 2.1 Native workflow: mission 자동 생성

파일:
- server/src/services/workflow/engine.ts
- server/src/__tests__/workflow-dag-engine.test.ts

내용:
- workflowService.trigger()에서 CreateWorkflowRunInput에 missionId가 없으면 mission을 자동 생성한다.
- ownerAgentId는 workflow step의 agentId를 우선 사용하고, 없으면 company의 첫 agent를 fallback으로 사용한다.
- 생성된 missionId를 workflow run input에 주입한 뒤 createWorkflowRun()을 실행한다.
- step issue도 missionId/originId/assigneeAgentId를 갖도록 검증 테스트를 추가했다.

### 2.2 Mission service: plugin entity workflow run 병합

파일:
- server/src/services/missions.ts
- server/src/__tests__/missions-service.test.ts

원인:
- Mission Execution Flow의 listWorkflowRuns()가 native workflow_runs 테이블만 조회했다.
- scheduled/reconciler run은 plugin_entities 기반 entityType workflow-run / workflow-definition / workflow-step-run 으로 저장된다.
- 따라서 plugin run이 data.missionId를 가지고 있어도 Mission > Execution Flow에 표시되지 않았다.

수정:
- listWorkflowRuns()에서 native workflow run과 plugin_entities 기반 workflow run을 병합해서 반환한다.
- plugin workflow-run 중 data.missionId == missionId이고 companyId가 mission.companyId인 항목을 조회한다.
- 관련 workflow-definition, workflow-step-run entity를 찾아 MissionWorkflowRunDetail 형태로 변환한다.
- issueId가 있으면 issues 테이블에서 issue title/label/status를 연결한다.
- step status는 plugin 표현을 native UI 표현으로 normalize한다:
  - done -> completed
  - in_progress -> running
  - backlog/todo -> pending
  - failed -> failed
  - skipped -> skipped

테스트:
- missions-service.test.ts에 "returns plugin entity workflow runs linked to a mission" 추가.
- plugin entity 기반 workflow run이 mission listWorkflowRuns 결과에 표시되는지 검증한다.

### 2.3 Workflow-engine plugin API URL fallback 정리

파일:
- /Users/kwak/Projects/paperclip/paperclip-addon/plugins/workflow-engine/src/worker.ts
- /Users/kwak/Projects/paperclip/paperclip-addon/plugins/workflow-engine/src/reconciler.ts

수정:
- PAPERCLIP_API_URL env var를 우선 사용한다.
- 기본 fallback은 http://localhost:3200 으로 통일했다.
- 3100 직접 fallback 및 중복 fallback을 정리했다.
- worker.ts의 직접 process.env.PAPERCLIP_API_URL || ... 사용을 helper 호출로 통일했다.
- reconciler.ts의 tool-registry 호출부도 helper 기반으로 통일했다.

## 3. 실제 E2E 검증 결과

Dev server:
- background process: proc_565f1fd71dd6
- pid: 28304
- command: pnpm dev
- status: running
- health check: curl -fsS http://127.0.0.1:3200/api/health -> status ok
- 로그에 Telegram poll retry warning이 반복되지만, dev server/API 동작과는 별개로 보임.

Scheduled/reconciler E2E 데이터:
- companyId: e9f0bd19-5447-4636-9595-d2b70b47e308
- company slug: CMPAA
- pluginId: f10fee03-75f0-4251-a356-17a1d9436fd8
- jobId: e55c0d45-804c-4139-84e3-54d25e027e8b
- workflowName: qa-scheduled-e2e-hermes-232805
- schedule: * * * * *
- step id: scheduled-step
- step agentName: 알프레드
- workflowRunId: b3040f6e-6e3f-4974-ad2a-76a2b00b86a5
- missionId: e4d1b0d1-54ce-4c5f-8a4d-77b95639d41f
- parent issue: CMPAA-72
- step issue: CMPAA-73

검증:
- workflow-reconciler job trigger 성공.
- scheduled run 생성 확인.
- mission 자동 생성 확인.
- GET /api/missions/e4d1b0d1-54ce-4c5f-8a4d-77b95639d41f/workflow-runs 에 plugin run 반환 확인.
- 브라우저 /CMPAA/missions/e4d1b0d1-54ce-4c5f-8a4d-77b95639d41f 접속 확인.
- Overview에서 Workflow count 1 확인.
- Execution Flow 탭에서 workflow run/step/agent(알프레드)/issue(CMPAA-73) 표시 확인.

## 4. 검증 명령 결과

Focused / intermediate verification:
- pnpm vitest run server/src/__tests__/missions-service.test.ts -t "returns plugin entity workflow runs linked to a mission"
  - RED 확인 후 구현, GREEN 통과.
- pnpm vitest run server/src/__tests__/missions-service.test.ts
  - 4 passed.
- pnpm --filter @paperclipai/server typecheck
  - passed.
- pnpm --filter @insightflo/paperclip-workflow-engine build
  - passed.
- pnpm --filter @insightflo/paperclip-workflow-engine test
  - 13 passed.
- pnpm vitest run server/src/__tests__/workflow-dag-engine.test.ts server/src/__tests__/plugin-routes-workflow-native-fallback.test.ts server/src/__tests__/missions-service.test.ts
  - 3 files, 15 tests passed.

Full verification, 2026-04-27 08:42-08:45 KST:
- pnpm -r typecheck
  - exit code 0.
- pnpm test:run
  - exit code 0.
  - Test Files 185 passed (185).
  - Tests 911 passed | 1 skipped (912).
- pnpm build
  - exit code 0.
  - ui build emitted known Vite warnings about node:fs externalization and large chunks; build completed successfully.

## 5. 별도 발견 버그: Work Board fixture id leak

이번 scheduled/reconciler 수정과 직접 관련 없는 별도 버그.

증상:
- Work Board mock fixture IDs가 live API로 흘러들어가 UUID validation 없이 Postgres query 실행 후 500 에러가 반복된다.
- 관측된 fixture IDs:
  - company-work-board-test
  - mission-1
  - task-1
  - task-2
  - orphan-1
  - issue-sherlock
  - issue-followup
  - issue-reissue

권장 처리:
- 별도 이슈/작업으로 분리.
- 수정 후보:
  1. 클라이언트에서 mock id면 live API fetch skip.
  2. 서버 route에서 UUID param validation을 추가해 400/404로 방어.
- 이번 작업의 완료 판정에는 포함하지 않음.

## 6. 남은 액션

필수 남은 작업:
- diff review 후 commit 여부 결정.
- 커밋 시 runtime repo와 external plugin repo를 섞지 말고 범위를 분리할 것.
- paperclip-addon repo는 pre-existing dirty가 매우 크므로 관련 workflow-engine 파일만 엄격히 stage해야 한다.

선택/후속 작업:
- Work Board fixture id leak 별도 수정.
- Telegram poll retry warning은 dev server 로그 노이즈로 별도 점검 가능.

## 7. 참고 명령

Runtime repo status/diff:
```sh
cd /Users/kwak/Projects/ai/papercompany/papercompany-runtime
git status --short
git diff --stat
```

Plugin repo 관련 파일만 확인:
```sh
cd /Users/kwak/Projects/paperclip/paperclip-addon
git diff -- plugins/workflow-engine/src/worker.ts plugins/workflow-engine/src/reconciler.ts
git diff --stat -- plugins/workflow-engine/src/worker.ts plugins/workflow-engine/src/reconciler.ts plugins/workflow-engine/dist/worker.js plugins/workflow-engine/dist/reconciler.js
```

Full verification:
```sh
cd /Users/kwak/Projects/ai/papercompany/papercompany-runtime
pnpm -r typecheck
pnpm test:run
pnpm build
```

Dev server health:
```sh
curl -fsS http://127.0.0.1:3200/api/health
```
