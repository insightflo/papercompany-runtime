# Workflow Control-Flow (IF + bounded back-edge loop) — 구현 계획 / 핸드오프

> 상태: **P0–P1 완료**(commit `63cf233`, branch `feat/workflow-control-flow-if-loop`). **P2부터 재개 필요.**
> 목표: 워크플로 엔진에 IF(조건부 edge) + bounded back-edge loop(QA 반려 → rework → 재QA) 추가.
> 배경: 기존엔 loop를 supervision(10분 poll + comment/status hack)로 흉내냄 → producer self-loop / vacuous 자동완료 / 재QA 미발화 버그. 엔진 네이티브 loop로 대체.

## 절대 원칙 (사용자 지시)
- **한 파일에 몰아넣지 말 것.** 제어 흐름 로직은 `control-flow/` 아래 모듈로 분리. `dag-engine.ts`엔 최소 hook만. (supervision.ts 1100줄 분해 사례 회피.)
- **가즈아 25h hang 회귀 금지.** maxIterations 하드 캡 + deterministic 테스트 필수.

## 엔진 ground-truth (코드 확정, dag-engine.ts)
- 단일 오케스트레이터: `syncWorkflowRunState`(L1977). 모든 상태 전이가 통과.
- step 활성화 게이트: `findRunnableSteps`(L1157) → `step.dependencies.every(dep => WORKFLOW_STEP_SUCCESS_STATUSES.has(dep.status))` + `status==="pending"`. `WORKFLOW_STEP_SUCCESS_STATUSES={"completed"}`(L87). `WORKFLOW_STEP_TERMINAL_STATUSES={completed,failed,skipped}`(L86).
- 첫 실패가 launch 중단: syncWorkflowRunState L1989–1991(`hasFailure` → skip launch loop). → failure-gated step 못 붙게 함. **P2에서 우회해야.**
- `detectCycle`(L414–449)가 모든 cycle reject → back-edge 구조적 불가. **P3에서 relax.**
- step은 1회만 실행(pending→terminal). `retry_count` 컬럼 존재 but **미사용**. `onFailure`/`escalateTo`/`maxRetries`는 **dead type-only**.
- step status = issue status 파생(`syncStepRunsFromIssueState`가 매 sync 덮어쓰). → step 리셋하려면 **issue도 같이 리셋**(같은 트랜잭션).
- QA fail 신호: `isValidationGateCandidate(step)` + `request_changes` verdict → stepRun "failed"(L837–842). verdict는 **persist 안 됨**(매 sync 재계산) → P4에서 metadata.attempts[]에 persist.
- finalize: `finalizeWorkflowRunState`(L1779) hasFailedStep + allStepsTerminal.
- status CHECK constraint(migration 0046:96) = pending|running|completed|failed|skipped. 새 status값은 migration 필요 → **pending→running + counter 재사용**.
- reconciler(`reconciler.ts:258`, 5분)가 stuck run(60min) 강제 kill = 유일 안전망 = 가즈아 hang 메커니즘.

## 설계 결정 (확정됨)
| 항목 | 결정 |
|---|---|
| edge 모양 | edge-annotated `conditionalDependencies: {stepId, when, isBackEdge?, maxIterations?}[]` (legacy `dependencies[]`는 success-only 보존) |
| loop 발화 조건 | `when: "qa_request_changes"` (generic "failure" ❌ — infra 에러 loop 방지) |
| iteration 저장 | 신규 `iteration_index` 컬럼(P1 추가 완료, migration 0063). `retry_count` 재사용 ❌ |
| verdict/결함 저장 | `step_run.metadata[controlFlowAttempts]` jsonb(attempts[]) — issue 리셋에도 잃지 않음 |
| maxIterations 범위 | per-edge |
| step status | pending→running + iteration_index counter (새 status값 ❌) |
| rework step 저작 | plan 시 자동 합성(QA step → 그 생산자로 back-edge, 기본 maxIterations=2) — `resolveProducerStepIdFromDag`(supervision-helpers.ts) 재사용 |
| supervision 폐기 | hybrid — native loop 있는 미션은 producer-rework 분기 가드(skip), legacy엔 유지 |

## 모듈 분해 (control-flow/ 아래, 각 ≤~300 LOC)
- `types.ts` ✅ P1 — ConditionalEdge/StepIterationAttempt/normalizeConditionalEdges
- `edge-condition.ts` — (P2) edge `when` 평가; findRunnableSteps 게이트 교체
- `cycle-validator.ts` — (P3) detectCycle relax(annotated back-edge 허용, 우연 cycle 거부)
- `step-reset.ts` — (P4) resetStepRunForRework: step+issue 같이 리셋, iteration_index++, attempt archive
- `loop-driver.ts` — (P4) syncWorkflowRunState의 back-edge 재발화 pass(maxIterations gate)
- `verdict-store.ts` — (P4) verdict/결함을 metadata.attempts[] persist

## 단계별 계획 (각 tsc+vitest 검증)
- **P0** ✅ baseline 검증.
- **P1** ✅ skeleton(types + iteration_index migration).
- **P2 IF(edge-condition)**: `findRunnableSteps`에서 conditionalDependencies의 `when` 평가; failure-gated step 활성화, false-branch는 `skipped`(governance spam 방지); 첫-failure short-circuit(L1989) 우회; finalize 조정(reachable-not-terminal → active). Files: edge-condition.ts(신규) + dag-engine.ts(얇은 hook).
- **P3 back-edge 허용(cycle-validator)**: detectCycle에서 annotated(`isBackEdge+maxIterations≥1`)만 통과, 나머지 cycle은 거부. Files: cycle-validator.ts(신규, dag-engine에서 분리) + dag-engine.ts(hook).
- **P4 loop driver + reset**: 실제 재실행. QA reset+재wake, maxIterations에서 종료. verdict persist. **무한 loop 가드 테스트 필수**. Files: step-reset.ts, loop-driver.ts, verdict-store.ts + dag-engine.ts(while-loop 내 pass 호출).
- **P5 planning(PAQO)**: QA step → rework back-edge 자동 합성. Files: mission-owner-plan-decisions.ts(buildPaqoWorkflowSteps), supervision-helpers.ts.
- **P6 supervision hybrid 가드**: native loop 미션은 producer-rework(L447–670) skip. Files: supervision.ts. (삭제 말고 가드 먼저.)
- **P7 hardening/테스트**: 7개 신규 테스트 + reconciler iterating-step 면제.
- **P-edit workflows editor**: UI에 IF/loop 저작 반영. 에디터 코드 위치 먼저 매핑 필요(papercompany-vane / UI 패키지 — Understand 맵에 미포함).

## 인프라 주의사항
- **migration은 수작업**: drizzle `_journal.json`이 0047에서 멈춰있고 0048~0062는 전부 수작업 .sql(journal 외부). `drizzle-kit generate` 쓰면 이미 존재하는 테이블을 다시 CREATE하는 잘못된 migration이 나옴(stale snapshot). **새 컬럼은 0063처럼 수작업 .sql로 추가**. migrate runner(client.ts)는 journal로 순서 정하지만 out-of-journal 파일도 filename 순으로 적용됨.
- **보안 훅**: `.claude/settings.json`의 security-scan command `timeout`이 원래 5s라 내부 `npm audit`(30s)에 걸려 매 편집 block. 현재 `timeout:60`으로 설정(gitignored/local). 근본 fix는 security-scan.cjs 내부 `npm audit` spawnSync timeout(30000)을 5s 이내로 줄이는 것. (settings.json은 gitignored라 커밋에 안 담김.)

## 재개 방법 (다음 세션)
1. `git checkout feat/workflow-control-flow-if-loop` (P1까지 있음).
2. 이 PLAN.md + types.ts 로 설계/결정 복구.
3. P2(IF)부터: `edge-condition.ts` 작성 → dag-engine.ts findRunnableSteps 게이트 교체 → finalize 조정 → 테스트.
4. 각 phase마다 tsc + `npx vitest run src/__tests__/workflow-dag-engine.test.ts src/__tests__/control-flow-types.test.ts` green 확인.
5. 모듈 분해 원칙·가즈아 무한 loop 가드 잊지 말 것.
