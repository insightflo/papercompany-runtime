# Backend Development Standards

> 백엔드 개발 표준 및 가이드라인

## 1. API 설계 표준

### 1.1 URL 컨벤션

```yaml
# 리소스 명명
resources:
  - 복수형 명사 사용: /users, /orders, /products
  - kebab-case 사용: /order-items, /user-profiles
  - 동사 사용 금지: /getUsers ❌ → /users ✅

# 계층 관계
hierarchy:
  - 중첩 경로로 표현: /users/{id}/orders
  - 최대 3단계까지만: /users/{id}/orders/{orderId}/items
  - 4단계 이상은 쿼리 파라미터로: /items?orderId=123

# 버전 관리
versioning:
  strategy: URL Path
  format: /api/v1/, /api/v2/
  deprecation: 6개월 전 공지
```

### 1.2 HTTP 메서드

| 메서드 | 용도 | 멱등성 | 요청 본문 |
|--------|------|--------|----------|
| GET | 조회 | ✅ | ❌ |
| POST | 생성 | ❌ | ✅ |
| PUT | 전체 교체 | ✅ | ✅ |
| PATCH | 부분 수정 | ❌ | ✅ |
| DELETE | 삭제 | ✅ | ❌ |

### 1.3 응답 형식

```json
// 성공 응답
{
  "data": { ... },
  "meta": {
    "timestamp": "2024-01-01T00:00:00Z",
    "requestId": "uuid"
  }
}

// 목록 응답 (페이지네이션)
{
  "data": [ ... ],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "hasMore": true
  }
}

// 에러 응답
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": [
      { "field": "email", "message": "Invalid email format" }
    ]
  }
}
```

### 1.4 HTTP 상태 코드

```yaml
success:
  200: OK (데이터 반환)
  201: Created (리소스 생성됨)
  204: No Content (성공, 본문 없음)

client_error:
  400: Bad Request (잘못된 요청)
  401: Unauthorized (인증 필요)
  403: Forbidden (권한 없음)
  404: Not Found (리소스 없음)
  409: Conflict (충돌)
  422: Unprocessable Entity (비즈니스 로직 실패)
  429: Too Many Requests (속도 제한)

server_error:
  500: Internal Server Error
  502: Bad Gateway
  503: Service Unavailable
```

---

## 2. 에러 처리 표준

### 2.1 예외 계층 구조

```python
# Python 예시
class AppException(Exception):
    """기본 애플리케이션 예외"""
    code: str
    message: str
    status_code: int = 500

class ValidationError(AppException):
    """입력 유효성 검증 실패 (400)"""
    status_code = 400

class AuthenticationError(AppException):
    """인증 실패 (401)"""
    status_code = 401

class AuthorizationError(AppException):
    """권한 없음 (403)"""
    status_code = 403

class NotFoundError(AppException):
    """리소스 없음 (404)"""
    status_code = 404

class ConflictError(AppException):
    """리소스 충돌 (409)"""
    status_code = 409

class BusinessLogicError(AppException):
    """비즈니스 규칙 위반 (422)"""
    status_code = 422
```

### 2.2 에러 코드 네이밍

```yaml
format: DOMAIN_CATEGORY_SPECIFIC
examples:
  - USER_NOT_FOUND
  - ORDER_PAYMENT_FAILED
  - AUTH_TOKEN_EXPIRED
  - VALIDATION_EMAIL_INVALID
```

---

## 3. 데이터베이스 접근 표준

### 3.1 Repository 패턴

```python
class BaseRepository(Generic[T]):
    async def find_by_id(self, id: UUID) -> T | None: ...
    async def find_all(self, filters: dict) -> list[T]: ...
    async def create(self, data: CreateDTO) -> T: ...
    async def update(self, id: UUID, data: UpdateDTO) -> T: ...
    async def delete(self, id: UUID) -> bool: ...
```

### 3.2 쿼리 최적화

```yaml
rules:
  - N+1 쿼리 방지 (eager loading, batch loading)
  - SELECT * 금지, 필요한 컬럼만 선택
  - 인덱스 활용 확인 (EXPLAIN ANALYZE)
  - 슬로우 쿼리 로깅 (> 100ms)

connection_pool:
  min_size: 5
  max_size: 20
  max_idle_time: 300s
```

### 3.3 트랜잭션 경계

```python
# 서비스 계층에서 트랜잭션 관리
async def create_order(data: OrderCreate) -> Order:
    async with db.transaction():
        # 모든 DB 작업이 하나의 트랜잭션
        inventory = await inventory_service.reserve(data.items)
        order = await order_repo.create(data)
        await event_bus.publish(OrderCreated(order))
        return order
```

---

## 4. 캐시 전략

### 4.1 캐시 패턴

| 패턴 | 사용 시점 | TTL |
|------|----------|-----|
| Read-Through | 자주 읽히는 데이터 | 5-30분 |
| Write-Through | 일관성 중요 | - |
| Cache-Aside | 일반적인 캐싱 | 5-60분 |
| Write-Behind | 쓰기 성능 중요 | - |

### 4.2 캐시 키 네이밍

```yaml
format: "{service}:{entity}:{identifier}:{version}"
examples:
  - user:profile:123:v1
  - order:list:user:456:v1
  - product:detail:789:v2
```

### 4.3 캐시 무효화

```yaml
strategies:
  - TTL 기반: 시간 경과 후 자동 만료
  - 이벤트 기반: 데이터 변경 시 무효화
  - 버전 기반: 캐시 키에 버전 포함
```

---

## 5. 로깅 표준

### 5.1 로그 레벨

| 레벨 | 용도 | 예시 |
|------|------|------|
| DEBUG | 개발 시 상세 정보 | 변수 값, 함수 진입/종료 |
| INFO | 정상 동작 기록 | 요청 처리 완료, 작업 시작 |
| WARNING | 잠재적 문제 | 재시도, 폴백 사용 |
| ERROR | 처리 가능한 오류 | API 호출 실패, 유효성 검증 실패 |
| CRITICAL | 시스템 장애 | 데이터베이스 연결 실패, 서비스 다운 |

### 5.2 구조화된 로깅

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "INFO",
  "service": "order-service",
  "traceId": "abc123",
  "spanId": "def456",
  "message": "Order created",
  "context": {
    "orderId": "order-789",
    "userId": "user-123",
    "amount": 10000
  }
}
```

### 5.3 민감 데이터 마스킹

```yaml
mask_fields:
  - password
  - creditCard
  - ssn
  - token
  - apiKey

mask_format: "***MASKED***"
```

---

## 6. 테스트 표준

### 6.1 테스트 피라미드

```yaml
unit_tests:
  coverage: ">= 80%"
  scope: 개별 함수/클래스
  mocking: 외부 의존성 모킹

integration_tests:
  coverage: 핵심 플로우
  scope: API 엔드포인트, DB 연동
  database: 테스트 컨테이너 사용

e2e_tests:
  scope: 주요 사용자 시나리오
  environment: 스테이징 환경
```

### 6.2 테스트 네이밍

```python
# 패턴: test_{메서드}_{조건}_{기대결과}
def test_create_order_with_valid_data_returns_order():
    ...

def test_create_order_with_invalid_email_raises_validation_error():
    ...
```

---

## 7. 보안 표준

### 7.1 인증/인가

```yaml
authentication:
  method: JWT (Access + Refresh Token)
  access_token_ttl: 15m
  refresh_token_ttl: 7d
  algorithm: RS256

authorization:
  method: RBAC (Role-Based Access Control)
  default_deny: true
  audit_logging: true
```

### 7.2 입력 유효성 검증

```yaml
rules:
  - 모든 입력은 유효성 검증 필수
  - 허용 목록 방식 (allowlist) 사용
  - SQL/XSS/Command Injection 방지
  - 파일 업로드 크기/타입 제한
```

---

## 8. 성능 표준

### 8.1 API 응답 시간

| 유형 | 목표 | 최대 |
|------|------|------|
| 간단한 조회 | < 50ms | 200ms |
| 복잡한 조회 | < 200ms | 500ms |
| 생성/수정 | < 200ms | 1000ms |
| 배치 작업 | - | 30s (비동기) |

### 8.2 페이지네이션

```yaml
defaults:
  page: 1
  limit: 20
  max_limit: 100

cursor_pagination:
  use_when: 대용량 데이터, 실시간 피드
  format: base64 encoded cursor
```

---

**Version**: 1.0.0
**Last Updated**: 2026-03-03
