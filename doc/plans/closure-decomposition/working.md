# 작업 진행 상태 — 클로저 분해 (P4/P5)

> 설계: `plan.md`. 이 파일은 매 step 업데이트. 중단 시 새 세션이 이 파일을 읽고 이어서 진행.

## 현재 상태
- **Phase**: 설계 완료 + **reviewer sub-agent 검토 완료(NEEDS_REVISION → 정정 반영)** → **P0 진행중**
- 검토 정정: isMissionOwnerActionParentPlacementRejected Layer0 명시, createMissionOwnerActionIssue→create 오탐 정정, Layer1↔CRUD 순환 무(원시 db.update) 확인, CRUD도 {db,deps} 필요 명시, **P3 검증 강화**(workflow-dag-engine.test 비-mock 본체 실행 확인 + 프로덕션 supervision 라우트 식별 + deps 콜백 회귀테스트 P3 직전 추가). plan.md 섹션 8 참조.
- **missions.ts**: 3727줄 (5 모듈 분리 완료)
- **commit/push**: 최신 `5f87e73`. working tree: plan.md/working.md 신규(doc/plans/closure-decomposition/).

## 다음 작업 (검토 통과 후)
1. **P0**: shared-types.ts — IssueRow, IssueCreateInput, JsonRecord 이동 + re-export. tsc+test.
2. **P1**: supervision-helpers.ts — Layer 0 pure helper ~24개 module-level 이동. tsc+test.
3. **P2**: owner-actions.ts — Layer 1 ensure*/create/reconcile factory `createOwnerActions({db,deps})`. **위험 중~고**. tsc+test+supervision-monitor test.
4. **P3**: supervision.ts — Layer 2 supervision factory `createSupervision(...)`. **위험 고** (1100줄). tsc+test 엄밀히.

## 완료 로그
- [x] 2026-06-20: 설계 문서 plan.md 작성 + 클로저 호출 그래프 분석 완료.

## 검증 게이트 (매 phase)
- `pnpm --filter @paperclipai/server typecheck` exit 0
- `pnpm vitest run server/src/__tests__/missions-service.test.ts server/src/__tests__/mission-owner-recovery-comments.test.ts server/src/__tests__/mission-owner-supervision-monitor.test.ts server/src/__tests__/mission-owner-plan-decisions.test.ts` 136/136
- 서버 restart boot OK (tmux `papercompany-runtime-dev`)
- commit + push

## 주의
- 같은 파일(missions.ts) 다수 편집 → 순차(동시 편집 충돌 회피).
- swarm ≤5: 검토/분석 병렬에 활용, 같은 파일 편집은 순차.
- security-scan hook이 큰 파일 편집 시 오탐 블록(advisory, 적용은 됨).
