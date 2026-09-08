# LOCAL SKETCH — shorts whole-flow (local only, NOT production)

이 파일과 디렉터리의 `local-sketch*.ts` 는 2026-09-08 "shorts whole sketch" 계획의
연결 스케치다. 하나의 로컬 명령이 Python 재사용 intake → 불변 receipt readback →
TypeScript preview/apply/deliver 코디네이터 → 어셈블리 도구 경계 → 사람 결정 경계 →
upload 결과를 잇는다. 작은 React 미리보기/확인 컴포넌트가 같은 코디네이터의
public view 를 콜백으로 소비한다. 포트는 명시적 로컬 fake 이고, 기존 계약과
그래프/적격성 구현(graph.ts / eligibility.ts / cu_submission_contract / cu_storage)은 실제다.

## Runnable commands

```sh
# O workspace (Python intake)
cd /Users/kwak/orca/workspaces/papercompany-operations/shorts-cu-resume/scripts/shorts-flow-runner
python3 -m pytest tests/test_cu_reuse_sketch.py -q          # focused
python3 -m pytest tests/ -q                                 # full existing suite

# R workspace (server)
cd /Users/kwak/orca/workspaces/papercompany-runtime/mission-resume/server
./node_modules/.bin/vitest run src/__tests__/shorts-whole-sketch.test.ts \
  src/__tests__/shorts-whole-sketch-corrections.test.ts \
  src/__tests__/shorts-whole-sketch-races.test.ts \
  src/__tests__/workflow-resume-graph.test.ts src/__tests__/workflow-resume-eligibility.test.ts
./node_modules/.bin/tsc --noEmit                            # source typecheck

# R workspace (UI)
cd /Users/kwak/orca/workspaces/papercompany-runtime/mission-resume/ui
./node_modules/.bin/vitest run src/components/ShortsResumeSketch.test.tsx
./node_modules/.bin/tsc -p tsconfig.json --noEmit           # UI typecheck
```

Python 스크립트 위치: R 테스트는 환경변수 `SHORTS_OPERATIONS_ROOT` 를 먼저 읽고,
없으면 R 구조에서 해석한 sibling workspace 기본값
`<R>/../../papercompany-operations/shorts-cu-resume` 을 사용한다.

## Real vs fake matrix

| 구성요소 | 상태 | 근거 |
| --- | --- | --- |
| `cu_submission_contract.validate_submission` (O) | REAL | 기존 제출 계약, sketch 가 그대로 호출 |
| `cu_storage.create_immutable` (O) | REAL | 조건부 단독 생성 + exact readback 재사용 |
| receipt/clip 저장 (O) | FAKE (filesystem) | 로컬 output dir 의 FileObjectStore — 공식 CU terminal result 아님, `shorts.local-reuse-receipt.v1` fixture |
| receipt hash | REAL (consumer) | TS `parseLocalSketchReceipt` 가 raw bytes 로 sha256 계산 |
| `forwardReachable` / `checkStepEligibility` (R) | REAL | 기존 그래프/적격성 순수 함수 사용 |
| registerArtifact/readArtifact 포트 | FAKE | 파일 raw bytes + 실제 SHA; production `registerWorkflowArtifactWithStorage` 미사용 |
| dispatchResume 포트 | FAKE (stub) | 미래 generation-aware engine 연결 자리 — 기존 `resumeRun` 호출 아님 |
| invokeTool 포트 (shorts-clips-verify / shorts-assemble / shorts-storage-list / shorts-publish-card / shorts-youtube) | FAKE | 실제 도구 이름/요청 모양 보존, 응답은 `shorts.local-sketch-tool-result.v1` + `local-sketch` envelope 플래그 (schema/mode 미충족 envelope 은 소비 금지) |
| readObject 포트 (video bytes 읽기) | FAKE | 합성 object map 에서 결정적 synthetic bytes 반환. assemble 시 video bytes SHA256 를 `videoSha256` 로 저장하고 전송 직전 재판정 — manifest digest 승인/bytes 변조는 `video_mismatch` 로 거절 |
| 선행 증거 문서 (`shorts.local-sketch-predecessors.v1`) | FAKE (주입) | 이후 시작 step(assemble/assemble-gate/final-review/양 blocked 분기/publish)의 합성 공급값. scope 10필드 + receiptSha256 가 receipt/expectedScope 와 정확히 일치해야 하고, 요구 증거 누락/불일치는 generation/dispatch 전에 `missing_predecessor_evidence` / `predecessor_scope_mismatch` 로 거절 |
| operator decision (create/read/resolve) | FAKE | 실제 resolve wire shape(actionId confirm + selection approve) 보존, 승인 binding 은 구조화 payload machine 필드 |
| 상태 저장소 | FAKE (injected store) | preview snapshot/generation/delivery state 보관, SQL 원자성 아님 |
| ShortsResumeSketch (UI) | FAKE (isolated) | production 마운트 없음, 승인 콜백/버튼 없음 |

## Explicitly NOT bound (unbound)

- Production routes: 미마운트 (POST /api/issues/:issueId/workflow/artifacts, GET
  /api/operator-decisions/:id, resolve route 등 어디에도 연결 없음).
- DB / live engine: 미연결. `workflowService.resumeRun` 을 호출하지 않는다(이 run 을
  reopen 할 수 없어서 신규 포트가 별도로 존재).
- Media / upload: 실제 미디어 생성·업로드 없음. 채널은 항상 합성
  `local-sketch-channel` 이고 presign/url 은 `.invalid` 합성값.
- Human approval: 실제 승인 권한 없음 — 결정은 테스트가 fake decision 을 실제 resolve
  wire shape 로 해결하는 것뿐. UI 컴포넌트는 승인 버튼을 갖지 않는다.
- Publication / credits: 공식 CU terminal result, within_budget 마킹, 신뢰된 과거
  credit/provenance 제조 없음. receipt credits 는 제출값의 verbatim 사본.

## Known limitations

- per-step eligibility 통과는 production resumability 인증이 아니다 (graph.ts /
  eligibility.ts 문서 주석과 동일 원칙).
- deliver 는 등록된 request 의 `startStepId` 를 그대로 존중한다(clips-gate 하드코드 없음).
  지원 시작은 7개 downstream id(clips-gate, assemble, assemble-gate, final-review,
  publish, clips-blocked, assemble-blocked)뿐이고 일반 DAG 엔진이 아니다.
- publish 불확정성 센티널(`uploadAttempted`)은 주입된 로컬 store 안의 순서 보장만이다.
  shorts-youtube 호출 전 동기 저장되고, 센티널 상태는 deliver/resolveReview 로 절대
  재전송하지 않는다(실패 후 reconciliation 조회). crash-durable SQL 원자성이나 분산
  동시성 증명이 아니며 재시도/리셋 API 도 없다.
- 늦게 재개되는 resolveReview/deliver decision-read 도 저장된 uploadAttempted/uploadResult 를
  지우지 못한다(await 이후 모든 delivery 저장은 saveDelivery 관문이 최신 store 상태를 재판정).
  회귀: `src/__tests__/shorts-whole-sketch-races.test.ts`(sleep 없는 게이트). 다만 이는 단일
  프로세스 로컬 메모리 store 의 단조 보존일 뿐, 외부 프로세스/재시작 사이의 no-resend
  보장이 아니다.
- 선행 증거 scope 비교는 새 증거 문서의 최소 소유 바인딩일 뿐이다. receipt 전체 재검증,
  서명/인증, 메타데이터 제안 비교, 원자 적용/outbox 같은 production 경화는 의도적으로
  범위 밖이다.
- 승인 binding 은 video bytes digest 에 묶인다(manifest digest fallback 없음). 대조는
  로컬 readObject fake 가 읽는 합성 bytes 기준이다 — 실제 저장소/네트워크 바인딩 아님.
- UI 테스트는 jsdom harness(기존 `OperatorDecisionCard.behavior.test.tsx` 관례)로
  exact ID 전달(select change / confirm click)을 실증한다. 다만 SSR 렌더 결과 전체의
  시각 검증은 아니며, production 마운트 E2E 는 존재하지 않는다.
- fake 상태 저장소는 in-memory 이며 통합 tempdir 영속화는 불필요해서 하지 않았다
  (계획상 "if needed").
