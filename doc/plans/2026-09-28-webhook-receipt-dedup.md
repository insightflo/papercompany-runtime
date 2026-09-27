# 인바운드 플러그인 웹훅 수신 영수증 — externalId 기반 중복 배달 차단

Date: 2026-09-26 · Worktree: `webhook-receipt` (branch `insightflo/webhook-receipt`)
출처: 이펙트 봉투 #279 이월 항목 (doc/plans/2026-09-27-effect-envelope.md)

## 최종 목표와 승인된 범위

- 목표: `POST /api/plugins/:pluginId/webhooks/:endpointKey` 가 externalId(제공자 배달 ID)가 같은
  배달을 워커에 이중 디스패치하지 않게 한다. 수신 시 영수증 1회 insert, 유니크 제약으로 동시성 안전.
- 범위 내: externalId 추출, 가산 마이그레이션 + unique index, 중복 처리 정책(성공/대기중/실패), 응답 계약 하위호환.
- 범위 외(제외): 워커 내부 handleWebhook 멱등화(플러그인 소관), 서명 검증 변경,
  제공자별 특화 추출기 목록, 플러그인 도구 실행 멱등(다음 슬라이스), UI.
- 제약: 이 워크트리에서만 작업. commit/push/merge/deploy 금지. 구현 파일 300줄 규칙(plugins.ts는 초과 레거시 → 늘리지 않고 줄인다).

## 명세 근거 (조사 결과)

1. PLUGIN_SPEC.md §18: "모든 배달 기록" + "웹훅 처리는 멱등(플러그인 소관)". 호스트 수준 영수증 중복 차단을 금지하지 않음.
2. PLUGIN_SPEC.md §21.3 `plugin_webhook_deliveries` 정의는 현행 구현과 이미 표류(명세 `endpoint_key`/`request_id`/`received|processed|failed|ignored` vs 구현 `webhook_key`/`external_id`/`pending|success|failed`). 구현이 살아있는 계약. 명세는 **externalId 추출 원천을 정의하지 않음** → 아래 보수 설계로 결정하고 근거를 명시한다.
3. 스키마 주석(`packages/db/src/schema/plugin_webhooks.ts`)이 이미 external_id를 "중복 배달 탐지·거거부용 선택적 ID"로 문서화 — 방향 일치.

## externalId 추출 설계 (보수, 위양성 오류 회피)

판단 원칙: 거짓 양성(서로 다른 배달을 같은 키로 묶어 실제 배달 누락)은 데이터 손실이므로
거짓 음성(중복 미탐지 = 기존 동작)보다 위험하다. 확정적 식별자만 사용한다.

추출 순서 (첫 유효값 채택, trim 후 비어있지 않은 문자열, 길이 ≤ 512):
1. 헤더 `x-delivery-id` (배달 식별자의 일반 관례)
2. 헤더 `x-webhook-id` (동일 계열 일반 관례)
3. payload 최상위 `deliveryId` (이름 자체가 배달 식별자)

제외 결정:
- payload 최상위 `id` — 제외. Shopify 등에서 payload `id`가 웹훅(객체)별로 상수라 서로 다른 배달이 같은 키로 묶여 실제 배달이 누락된다. 이름이 배달을 지칭하지 않는 한 사용하지 않는다. (과업 예시에 `id`가 언급되었으나 위험 근거로 제외 — 이것이 "계획 문서에 근거 명시"의 대상)
- 제공자별 헤더(예: GitHub `x-github-delivery`) — 이 슬라이스 제외 항목. 추출 원천 목록은 공식 명세가 생기면 그것이 우선.

미발견 시 `external_id = null` → 기존 동작(매 요청 처리). Postgres 유니크 인덱스는 NULL을 서로 다르게 보므로 null 다중 허용.

## 중복 처리 정책 (fail-closed + 제공자 재시도 허용)

알고리즘 (신규 서비스 `server/src/services/plugin-webhook-receipt.ts`):

```
externalId = extract(headers, payload)
if externalId == null:  평범 insert(레거시 경로) → dispatch
else:
  insert ... on conflict (plugin_id, webhook_key, external_id) do nothing returning id
  행 반환됨 → 최초 수신자 → dispatch (pending 상태로 insert됨)
  충돌(행 없음) → 기존 행 select:
    status = success 또는 pending → { deliveryId, status: "duplicate" }, HTTP 200, worker 호출 없음
      - pending: 동시 도착. insert 원자성으로 정확히 한쪽만 수신자. 늦은 쪽은 즉시 duplicate 응답.
        (수신자가 이후 실패해도 502 → 제공자가 재시도 → 그때 failed 경로로 재디스패치되어 손실 없음)
    status = failed → 제공자 재시도 유효:
      guarded update: set status=pending, error=null, startedAt=now, finishedAt=null, durationMs=null
        where id=X and status='failed'
      1행 갱신 → 재디스패치 1회 (기존 행 재사용, 새 insert 아님 → 유니크 유지)
      0행 갱신 → 다른 동시 재시도가 점유 → duplicate 응답
  select 빈 행(극히 드문 삭제 경쟁) → 최대 3회 재시도 루프 → 미해결 시 500 (fail-closed, 제공자 재시도 유도)
```

- 워커 RPC 실패 → 기존대로 행 failed 표기 + 502. 영수증 정책과 독립 (요구사항 5).
- 응답 계약: `{ deliveryId, status }` 유지. 신규 응답 전용 상태값 `"duplicate"` 추가.
  DB 컬럼 상태(pending|success|failed)에는 저장하지 않는다 — 기존 행 상태는 그대로 보존.

## 파일 구조

- Modify: `packages/db/src/schema/plugin_webhooks.ts` — uniqueIndex `(plugin_id, webhook_key, external_id)` 추가
- Create: 마이그레이션 (`pnpm db:generate`, 가산 CREATE UNIQUE INDEX)
- Create: `server/src/services/plugin-webhook-receipt.ts` — `extractExternalId` + `ingestWebhookDelivery` (수신 영수증 + 디스패치 + 상태 완결 + 응답 매핑). plugins.ts에서 Step 5~8(약 130줄)을 이전 → plugins.ts 늘어나지 않고 줄어듦 (300줄 규칙 준수)
- Modify: `server/src/routes/plugins.ts` — 검증(Step 1~5) 후 서비스 호출 + 결과 전송으로 교체
- Create: `server/src/__tests__/plugin-webhook-receipt.test.ts` — embedded PG + 모의 registry + 워커 스텁
- Modify: `doc/plugins/PLUGIN_SPEC.md` — §18 규칙 및 §21.3 표에 가산 노트 (추출 원천 + 유니크 인덱스)

## 작업 단계와 완료 증거

### Task 1: 스키마 유니크 인덱스 + 마이그레이션 — 완료
- [x] schema에 uniqueIndex 추가, `pnpm db:generate` → `0115_clean_machine_man.sql`
- [x] 생성 SQL 가산 단일 문 확인: `CREATE UNIQUE INDEX "plugin_webhook_deliveries_external_idx" ... ("plugin_id","webhook_key","external_id")`. 기존 데이터 external_id 전부 NULL이라 위반 불가.
- [x] `pnpm -r typecheck` 통과 (2026-09-26)

### Task 2: 통합 테스트 작성 — 완료 (Red 확인)
- [x] `plugin-webhook-receipt.test.ts` 12개 테스트 (요구 (a)~(g) + 검증 회귀 + extractExternalId 단위 5건)
- [x] 서비스 미존재로 적재 실패 확인 (Red) 후 구현
- 설계 보강: (g) stale pending 인수 — 원 디스패치 크래시로 방치된 pending 행이 재시도를 영구 삼키는 silent loss 방지 (5분 임계, 가드 업데이트)

### Task 3: 서비스 구현 + 라우트 교체 — 완료 (Green)
- [x] `plugin-webhook-receipt.ts` (240줄) 구현
- [x] plugins.ts 2337→2294줄 (순감소, 300줄 규칙 준수)
- [x] 신규 테스트 12/12 통과

### Task 4: 회귀 + 전체 검증 — 완료
- [x] 대표 회귀: plugin-* + workflow-webhook-* 16파일 95테스트 통과
- [x] `pnpm -r typecheck` 통과 · `pnpm build` 통과
- [x] PLUGIN_SPEC.md §18 규칙 6 + §21.3 구현 노트 가산 업데이트

## 전체 `pnpm test:run` 결과 해석 (선재 플레이크 입증)

- 내 변경 포함 3회: 919~920파일 통과, 매번 서로 다른 1~2파일 실패
  (workflow-frozen-native-resume — `"NR"+randomUUID().slice(0,3)` 접두어 충돌 / heartbeat-effect-envelope · run-terminal-generation-stamp · workflow-step-status-fencing — 임베디드 PG 기동 10초 훅 타임아웃).
- 실패 파일 전부 plugin/webhook 참조 0개, 고립·편성 반복 실행 전량 통과.
- 기저 커밋(변경 stash 후) 2회: 각각 서로 다른 1파일 실패 (최종 mention-wake-serialization.integration — 8d28df5 영역).
- 결론: 전체 스위트의 기계 부하 플레이크가 선재하며 본 변경과 무관. 플러그인·웹훅 도메인은 전 회차 녹색.
