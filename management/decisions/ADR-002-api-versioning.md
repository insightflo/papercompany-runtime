# ADR-002: API 버전 관리 정책

## Status
Accepted

## Context

papercompany는 다음 세 가지 API 소비자를 갖는다:

1. **에이전트 어댑터(adapters)** — claude-local, codex-local, cursor-local, gemini-local 등. heartbeat, 세션, 이슈, 미션 API를 호출한다. 어댑터 코드는 서버와 독립적으로 배포되거나 업데이트될 수 있다.
2. **React UI** — 같은 저장소에 있으며 서버와 동시에 배포되지만, 브라우저 캐싱으로 인해 구버전 클라이언트가 신버전 API에 접근하는 시나리오가 있다.
3. **SRB 웹훅 수신측(cross-server SRB)** — 원격 papercompany 인스턴스가 `/srb/webhook`을 호출한다. 두 인스턴스의 버전이 다를 수 있다.

이 세 소비자는 각각 다른 업데이트 주기를 가지며, 특히 에이전트 어댑터는 운영자가 개별적으로 관리한다. 플러그인(workflow-engine, tool-registry, knowledge-base)이 네이티브 서비스로 마이그레이션되면서 관련 API 엔드포인트의 폐기 절차도 명확하게 정의해야 한다.

## Decision

### 1. URL 경로 버전 관리 (`/api/v1/`)

모든 에이전트/클라이언트 facing REST API는 URL 경로에 버전을 포함한다.

```
/api/v1/missions
/api/v1/missions/:id/issues
/api/v1/worktree/rules
/api/v1/scheduler/schedules
/api/v1/channel/config
/srb/webhook          (SRB webhook은 별도 네임스페이스 — 아래 참조)
/maintenance/...      (maintenance 전용 — 아래 참조)
/metrics              (Prometheus 스크레이핑 — 버전 없음)
```

**버전 정책:**
- **v1**: 현재 구현. 모든 신규 엔드포인트는 v1으로 시작한다.
- **마이너 변경**(필드 추가, 선택적 파라미터 추가): v1 내에서 하위 호환으로 수용한다.
- **브레이킹 변경**(필드 제거, 타입 변경, 동작 변경): v2 네임스페이스를 생성하고 v1을 최소 한 Phase(약 1-2주) 유지한다.

**SRB 웹훅 버전 관리:**
SRB webhook 엔드포인트(`POST /srb/webhook`)는 URL 버전 대신 요청 헤더로 프로토콜 버전을 전달한다:
```
X-SRB-Protocol-Version: 1
```
수신측은 지원하지 않는 버전에 대해 `400 Bad Request`를 반환한다. 이 방식은 원격 서버 URL을 변경하지 않고 프로토콜을 진화시킬 수 있게 한다.

**maintenance 엔드포인트:**
`/maintenance/*` 경로는 버전 접두어를 포함하지 않는다. maintenance company 전용 기능은 내부 운영 목적이며 외부 에이전트가 직접 호출하지 않는다.

### 2. 에이전트 facing 엔드포인트 하위 호환 정책

에이전트 어댑터는 서버와 독립적으로 배포되므로 하위 호환성이 중요하다.

**허용되는 변경 (하위 호환):**
- 응답 객체에 새로운 선택적 필드 추가
- 요청에 새로운 선택적 파라미터 추가 (기본값 있음)
- 새로운 엔드포인트 추가
- 새로운 오류 코드 추가 (기존 HTTP 상태 코드 재사용)

**금지되는 변경 (브레이킹):**
- 필수 요청 필드 추가 또는 기존 필드 제거
- 응답 필드 이름 변경 또는 제거
- HTTP 상태 코드 변경
- 인증 방식 변경
- URL 구조 변경

**버전 공존 전략:**
브레이킹 변경이 필요할 경우:
1. `/api/v2/` 네임스페이스를 생성하고 신규 동작을 구현한다.
2. `/api/v1/` 엔드포인트는 최소 한 Phase 동안 레거시 모드로 유지한다.
3. v1에 `Deprecation` 응답 헤더를 추가하여 클라이언트에 폐기 예정을 알린다.
4. 어댑터 코드가 v2로 전환된 것을 확인한 후 v1을 제거한다.

### 3. 플러그인 → 서비스 마이그레이션 폐기 절차

workflow-engine, tool-registry, knowledge-base, service-request-bridge 플러그인이 네이티브 서비스로 대체되면서 플러그인이 노출하던 내부 API(PluginContext 기반)는 폐기된다.

**폐기 단계:**

```
단계 1 — 서비스 구현 완료 (P2-P6):
  - 플러그인 서비스 코드를 server/src/services/ 로 lift
  - 플러그인 디렉토리에 DEPRECATED 마킹 (packages/plugins/{name}/DEPRECATED)
  - 플러그인 로더에서 해당 플러그인 제외 (플러그인 자체는 삭제하지 않음)

단계 2 — 잔존 참조 제거:
  - server/src/ 에서 플러그인 직접 import 제거
  - verify_all.sh V-07: grep으로 server/src/ 내 플러그인 참조 0건 확인

단계 3 — 최종 정리 (모든 Phase 완료 후):
  - packages/plugins/{deprecated} 디렉토리 삭제
```

**API 관점의 영향:**
플러그인이 REST API를 직접 노출하지는 않았으므로 외부 소비자에 대한 API 브레이킹 변경은 없다. 내부 서비스 인터페이스 변경은 TypeScript 컴파일 오류로 감지된다.

### 4. `/maintenance/*` 경로 규약

maintenance company 전용 기능은 `/maintenance/` 접두어 아래에만 위치한다.

```
/maintenance/worktree/rules          — 다른 company에 룰 배포
/maintenance/tools/builtins          — 내장 도구 등록
/maintenance/agents/:id/code         — 에이전트 코드 수정
/maintenance/instance/settings       — 인스턴스 수준 설정
```

이 경로들은 `requireMaintenanceCompany()` 미들웨어가 라우트 prefix 수준에서 일괄 적용되어 보호된다. 개별 라우트에서 이 미들웨어를 적용하는 것은 금지된다 (ADR-003 참조).

## Consequences

### Positive
- URL 경로 버전 관리는 클라이언트에서 명시적으로 버전을 선택할 수 있어 예상치 못한 브레이킹 변경으로부터 보호한다.
- 플러그인 폐기 단계가 명확하여 언제 코드를 삭제해도 안전한지 판단하기 쉽다.
- `/maintenance/*` 경로 규약이 보안 게이트와 URL 구조를 일치시켜 라우트 추가 시 게이트 누락 가능성을 줄인다.

### Negative
- URL 버전 관리는 동일한 엔드포인트를 여러 버전에 걸쳐 유지하는 비용을 발생시킨다.
- 에이전트 어댑터 코드가 버전을 하드코딩하면 서버 업그레이드 시 어댑터도 함께 업데이트해야 한다.

### Risks
- 개발자가 신규 라우트를 `/maintenance/` 접두어 없이 추가하고 per-route 미들웨어를 적용하면 보안 게이트가 우회된다. 이는 ADR-003과 verify_all.sh V-01로 방지한다.
- SRB 웹훅 프로토콜 버전 협상이 실패하면 크로스 서버 SRB 전체가 중단된다. 수신측은 지원하는 최소 버전을 명확히 문서화해야 한다.

## Enforcement

| 항목 | 강제 방법 |
|------|----------|
| 에이전트 facing API `/api/v1/` 접두어 | `routes/index.ts`의 라우트 마운트 코드 검토 — v1 없이 마운트되는 라우트는 PR 리뷰에서 차단. |
| 플러그인 잔존 참조 제거 | `verify_all.sh V-07`: `grep -r "packages/plugins/workflow-engine\|tool-registry\|knowledge-base\|service-request-bridge" server/src/` 결과 0건 확인. Phase 완료 시 실행. |
| `/maintenance/*` 경로 일관성 | `verify_all.sh V-01`: `routes/index.ts`에 `/maintenance` prefix 미들웨어 존재 + per-route 적용 부재 lint. |
| 브레이킹 변경 감지 | TypeScript 컴파일 오류 — 타입 변경 시 모든 호출부에서 컴파일 실패. CI에서 빌드 블록. |
| SRB 프로토콜 버전 헤더 | `srb-webhook.ts`에서 `X-SRB-Protocol-Version` 헤더 파싱 + 미지원 버전 400 반환. 단위 테스트로 검증. |
