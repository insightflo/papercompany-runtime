# B-3: 플러그인 도구 실행 멱등 — POST /api/plugins/tools/execute 수신 영수증

지시문: /tmp/glm-task-b3.md (컨트롤러 확정 계약). 브랜치 insightflo/tool-exec-idempotency.

## 목표/범위
- idempotencyKey 선택 필드 추가, 키 있을 때만 영수증 (company_id, run_id, tool, idempotency_key) 유니크.
- replay(completed) / 409(신선 executing) / 10분 스테일 인수 / 404·검증·인가·501은 행 없음.
- 웹훅 영수증(plugin-webhook-receipt.ts) 관용구 준용. 웹훅 코드·condense·인가·requestId 변경 금지.

## 단계별 완료 조건
1. 스키마+migration 0116 — pnpm db:generate, journal 갱신 확인.
2. 서비스(claim/complete/release/normalize) — typecheck.
3. 라우트 통합 — 실행 방출 지점(recordable)과 조기 반환(비기록) 구조 분리.
4. 문서 — PLUGIN_SPEC.md §13.10 절 + 라우트 doc comment.
5. 테스트 — 신규 (a)~(i) + 회귀 4종 녹색, pnpm -r typecheck && pnpm build.

## 설계 판단 (계약에서 명시 안 된 부분)
- claim 시점: 인가 통과 후·실행 직전. 코어 분기 404(not-found)로 떨어질 때만 자체 claim 삭제(release) — "행을 남기지 않음"+테스트(i) 충족. 타 요청 소유 행은 절대 삭제 안 함.
- 코어 분기 catch 500(resolveRunStepEnv 포함)은 기록 대상으로 간주(재실행 방지 우선).
- workflow_run_id/step_id는 코어 완료 시점에만 기록(plugin 분기는 stepEnv 해석 안 함 — 현행 코드 동일).

## 검증 증거 (2026-09-28)
- `pnpm -r typecheck` → 마지막 줄 `cli typecheck: Done` (exit 0)
- 신규 `server/src/__tests__/plugin-tool-execute-idempotency.test.ts` → `Tests 11 passed (11)`
- 회귀 (projectless / tool-result-hygiene / workflow-native-fallback / dispatcher-core-integrated / webhook-receipt) → `Test Files 5 passed (5)`, `Tests 41 passed (41)`
- `pnpm build` → `cli build ... Done` (exit 0, ui build Done 포함)
- migration: `packages/db/src/migrations/0116_curved_molecule_man.sql` + `meta/_journal.json` idx 116 + `0116_snapshot.json` 생성 확인
- 전체 `pnpm test:run`: 6926~6931 passed, 매회 서로 다른 선행 플래키 실패(mention-wake-serialization / heartbeat-effect-envelope / workflow-child-fix5-schema). mention-wake는 베이스 6b7a50f 워크트리 격리 실행에서도 3회 중 2회 실패 → 선행 결함, 본 변경과 무관.

## 결과 상태
- 전 단계 완료. 커밋은 리뷰 전 대기(컨트롤러 지시 없음).
