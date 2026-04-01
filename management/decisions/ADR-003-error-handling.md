# ADR-003: 오류 처리 표준

## Status
Accepted

## Context

papercompany는 다음과 같이 다양한 오류 발생 지점이 있다:

- **Worktree 룰 위반** — 에이전트 액션이 MUST 룰에 걸렸을 때. 에이전트 run을 즉시 중단해야 하며, 단순한 비즈니스 로직 오류와 구분되어야 한다.
- **SRB 웹훅 보안 검증** — HMAC 서명 불일치, 타임스탬프 범위 초과, 재사용된 nonce. 이 경우 401을 반환해야 하며 요청 처리를 계속하면 안 된다.
- **company_kind 게이트** — business company가 `/maintenance/*` 엔드포인트에 접근할 때. 403을 반환하고 오류 코드를 구체적으로 명시해야 한다.
- **일반 클라이언트/서버 오류** — 입력 유효성 검사 실패, 리소스 없음, 중복 생성 등.

에이전트 어댑터와 React UI가 모두 API를 소비하므로 오류 응답 스키마가 일관되어야 파싱과 오류 처리 코드를 재사용할 수 있다. 또한 에이전트는 오류 메시지를 그대로 사용자에게 노출하거나 재시도 여부를 결정하는 데 사용하므로, 오류 코드가 기계가 읽을 수 있는 구조를 가져야 한다.

## Decision

### 1. JSON 오류 응답 스키마

모든 오류 응답은 다음 구조를 따른다:

```typescript
// 오류 응답 타입 정의
interface ErrorResponse {
  error: {
    code: string;       // 기계가 읽는 식별자 (SCREAMING_SNAKE_CASE)
    message: string;    // 사람이 읽는 설명 (한국어 또는 영어)
    details?: unknown;  // 추가 컨텍스트 (선택적)
  };
}
```

예시:
```json
{
  "error": {
    "code": "WORKTREE_VIOLATION",
    "message": "이 액션은 MUST 룰에 의해 차단되었습니다: 프로덕션 DB 직접 쓰기 금지",
    "details": {
      "ruleId": "rule-001",
      "ruleName": "No direct prod database writes",
      "action": "tool:invoke",
      "alternatives": ["Use staging env", "Open an approval issue first"]
    }
  }
}
```

**스키마 설계 원칙:**
- `error.code`는 SCREAMING_SNAKE_CASE 문자열 상수다. 에이전트는 이 값으로 분기 처리한다.
- `error.message`는 사람이 읽기 위한 텍스트다. 프로그래밍 방식으로 파싱해서는 안 된다.
- `error.details`는 오류 타입별로 구조가 다를 수 있는 추가 데이터다. 없는 경우 키 자체를 생략한다(null이 아닌 생략).
- 성공 응답에는 `error` 키가 없다. 응답에 `error` 키가 있으면 실패다.

### 2. HTTP 상태 코드 사용 규칙

| 코드 | 의미 | 사용 상황 |
|------|------|----------|
| `200 OK` | 성공 | GET, PATCH 성공 |
| `201 Created` | 생성 성공 | POST로 리소스 생성 성공 |
| `204 No Content` | 내용 없는 성공 | DELETE 성공 |
| `400 Bad Request` | 클라이언트 입력 오류 | 요청 바디 유효성 검사 실패, 잘못된 cron 식, 잘못된 predicate 형식, 패턴 길이 초과 |
| `401 Unauthorized` | 인증 실패 | JWT 없음, JWT 만료, HMAC 서명 불일치, 타임스탬프 범위 초과, nonce 재사용 |
| `403 Forbidden` | 권한 부족 | company_kind 게이트 통과 실패 (business → maintenance 접근), 권한 없는 리소스 접근 |
| `404 Not Found` | 리소스 없음 | 존재하지 않는 mission/rule/schedule ID 조회 |
| `409 Conflict` | 상태 충돌 | 이미 존재하는 리소스 재생성, mission 상태 전이가 불가한 경우 |
| `422 Unprocessable Entity` | 의미론적 오류 | 구문은 맞지만 비즈니스 규칙 위반 (예: disabled된 rule에 approved 상태 전이 시도) |
| `500 Internal Server Error` | 서버 오류 | 예상치 못한 예외, DB 연결 실패, re2 초기화 실패 |

**400 vs 422 구분 원칙:**
- 400: 요청 형식 자체가 잘못된 경우 (필수 필드 누락, 잘못된 타입, 스키마 위반)
- 422: 형식은 올바르지만 현재 시스템 상태에서 처리할 수 없는 경우 (비즈니스 규칙 위반)

### 3. WorktreeViolation — MUST 블록

MUST 룰 위반은 서버 내부에서 `WorktreeViolation` 예외로 표현되며, 반드시 `403 Forbidden`으로 변환되어야 한다.

```typescript
// 오류 코드 상수
const ERROR_CODES = {
  // Worktree
  WORKTREE_VIOLATION:       "WORKTREE_VIOLATION",       // MUST 룰 위반 → 403
  WORKTREE_WARNING:         "WORKTREE_WARNING",          // SHOULD 룰 위반 → 경고 (응답에 포함)

  // SRB 보안
  SRB_HMAC_INVALID:         "SRB_HMAC_INVALID",          // HMAC 서명 불일치 → 401
  SRB_TIMESTAMP_EXPIRED:    "SRB_TIMESTAMP_EXPIRED",     // |now-ts| > 300초 → 401
  SRB_NONCE_REPLAYED:       "SRB_NONCE_REPLAYED",        // nonce 중복 → 401

  // company_kind 게이트
  MAINTENANCE_COMPANY_REQUIRED: "MAINTENANCE_COMPANY_REQUIRED", // → 403

  // 일반
  NOT_FOUND:                "NOT_FOUND",                 // → 404
  ALREADY_EXISTS:           "ALREADY_EXISTS",            // → 409
  VALIDATION_FAILED:        "VALIDATION_FAILED",         // → 400
  BUSINESS_RULE_VIOLATED:   "BUSINESS_RULE_VIOLATED",    // → 422
  INTERNAL_ERROR:           "INTERNAL_ERROR",            // → 500
} as const;
```

**WorktreeViolation 오류 응답 예시 (`403`):**
```json
{
  "error": {
    "code": "WORKTREE_VIOLATION",
    "message": "이 액션은 MUST 룰에 의해 차단되었습니다.",
    "details": {
      "ruleId": "rule-001",
      "ruleName": "No direct prod database writes",
      "severity": "MUST",
      "action": "tool:invoke",
      "toolName": "db_execute",
      "decisionMap": {
        "context": "Prod DB had two accidental deletes in Q1 2025",
        "rationale": "Zero-touch prod requires change-request approval",
        "alternatives": ["Use staging env", "Open an approval issue first"]
      }
    }
  }
}
```

에이전트 어댑터는 `error.code === "WORKTREE_VIOLATION"`을 수신하면 현재 run을 즉시 중단하고 `error.details.decisionMap.alternatives`를 사용자에게 안내해야 한다.

### 4. HMAC 검증 실패 → 401

SRB 웹훅 수신 엔드포인트(`POST /srb/webhook`)는 다음 순서로 검증을 수행하며, 실패 시 즉시 처리를 중단하고 `401`을 반환한다:

1. `X-SRB-Timestamp` 파싱 — 누락 시 `401 / SRB_TIMESTAMP_EXPIRED`
2. `|now - timestamp| > 300초` 확인 — 초과 시 `401 / SRB_TIMESTAMP_EXPIRED`
3. `X-SRB-Signature` HMAC-SHA256 검증 — 불일치 시 `401 / SRB_HMAC_INVALID`
4. `X-SRB-Idempotency-Key` nonce 중복 확인 — 이미 처리된 nonce 시 `401 / SRB_NONCE_REPLAYED`

401 응답에는 `WWW-Authenticate` 헤더를 포함하지 않는다 — HMAC 기반 인증이며 표준 Bearer 체계가 아니다.

### 5. 클라이언트 오류 vs 서버 오류 구분

**클라이언트 오류 (4xx):**
- 재시도가 무의미하다 — 같은 요청을 다시 보내도 같은 오류가 발생한다.
- 오류의 원인이 요청 자체에 있다.
- `error.details`에 어떤 필드가 잘못됐는지, 어떻게 고쳐야 하는지를 포함한다.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "cron_expression 형식이 올바르지 않습니다.",
    "details": {
      "field": "cron_expression",
      "value": "* * * *",
      "reason": "cron 식은 5개 필드가 필요합니다."
    }
  }
}
```

**서버 오류 (5xx):**
- 재시도가 유효할 수 있다 — 일시적 장애일 수 있다.
- 오류의 원인이 서버 내부에 있다.
- `error.details`에 내부 스택 트레이스나 민감한 정보를 포함하지 않는다.
- 서버 로그에는 상세 오류를 기록한다(request_id로 연결).

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "요청을 처리하는 중 내부 오류가 발생했습니다.",
    "details": {
      "requestId": "req-abc123"
    }
  }
}
```

### 6. SHOULD 룰 위반 처리

SHOULD 룰 위반은 에이전트를 차단하지 않는다. 액션은 진행되지만 경고를 응답에 포함하고 Telegram 알림을 발송한다.

**구현:** 성공 응답(200/201)의 응답 바디에 `warnings` 배열을 포함한다.

```json
{
  "result": { ... },
  "warnings": [
    {
      "code": "WORKTREE_WARNING",
      "ruleId": "rule-002",
      "message": "이 액션은 SHOULD 룰에 대한 경고입니다. 계속 진행됩니다.",
      "severity": "SHOULD"
    }
  ]
}
```

에이전트는 `warnings` 배열을 파싱하여 SHOULD 위반을 인지하고 실행 로그에 기록할 수 있다.

## Consequences

### Positive
- 일관된 `{ error: { code, message, details? } }` 스키마로 에이전트 어댑터와 UI의 오류 처리 코드를 단순화한다.
- `error.code`가 기계 판독 가능한 상수이므로 에이전트가 분기 없이 오류 종류를 판별하고 적절히 반응할 수 있다.
- `WorktreeViolation`이 명확한 403 + 전용 코드로 변환되므로 MUST 블록 이벤트를 모니터링 시스템에서 쉽게 탐지할 수 있다.
- 401로 일관된 HMAC 검증 실패 처리가 SRB 보안 감사를 단순화한다.

### Negative
- SHOULD 위반을 `warnings` 배열로 포함하는 방식은 소비자가 경고를 무시해도 탐지하기 어렵다. 모든 어댑터가 `warnings` 필드를 처리하도록 강제하는 방법이 없다.
- 성공 응답에 `warnings`를 포함하는 것은 REST 관례에서 벗어난다. 일부 소비자가 오해할 수 있다.

### Risks
- `error.details`에 내부 구현 정보(파일 경로, DB 쿼리 등)가 실수로 포함될 경우 보안 정보가 누출된다. 5xx 오류의 `details`는 `requestId`만 포함하는 것을 원칙으로 한다.
- Drizzle 또는 Node.js 런타임에서 발생한 예외가 표준 오류 스키마로 변환되지 않고 그대로 응답되면 스키마 일관성이 깨진다. 전역 오류 핸들러 미들웨어가 반드시 모든 미처리 예외를 포착해야 한다.

## Enforcement

| 항목 | 강제 방법 |
|------|----------|
| WorktreeViolation → 403 | `harness.ts`에서 `WorktreeViolation`을 throw하고, Express 전역 오류 핸들러에서 이 타입을 감지하여 403으로 변환. 단위 테스트: MUST 룰 위반 시 응답 코드 403 + `WORKTREE_VIOLATION` code 검증. |
| HMAC 실패 → 401 | `srb-webhook.ts`에서 검증 실패 시 401 즉시 반환. 통합 테스트: 잘못된 서명/만료 타임스탬프/재사용 nonce 각각에 대해 401 응답 검증. |
| 오류 스키마 일관성 | TypeScript `ErrorResponse` 인터페이스를 공유 타입 패키지에 정의. 오류 응답을 생성하는 모든 경로에서 이 타입을 사용. Express 전역 오류 핸들러가 최후 안전망으로 동작. |
| 5xx details 정보 누출 방지 | 코드 리뷰 체크리스트: 500 응답의 `details`에 스택 트레이스, DB 쿼리, 파일 경로가 포함되지 않는지 확인. |
| maintenance company_kind 게이트 → 403 | `verify_all.sh V-08`: CI 통합 테스트에서 business-company JWT로 `/maintenance/*` 호출 시 403 + `MAINTENANCE_COMPANY_REQUIRED` 검증. |
