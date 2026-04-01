# ADR-001: 기술 스택 선택

## Status
Accepted

## Context

papercompany는 paperclip-orginal을 포크한 자율 에이전트 운영 플랫폼이다. 기존 코드베이스를 최대한 재사용하면서 다섯 가지 핵심 역량(워크플로우 오케스트레이션, 도구 관리, 지식 검색, 실행 거버넌스, 스케줄링)을 서버 런타임에 직접 통합해야 한다. 이 과정에서 기술 스택에 관한 여러 결정이 필요하다.

주요 의사결정 압력:
- 솔로 개발자 + Claude Code 지원 체계 — 팀 규모가 작으므로 복잡성 통제가 중요하다.
- Self-hosted 배포 — 운영자가 NAT/방화벽 내부 환경에 있을 수 있다.
- 기존 paperclip 코드베이스와의 연속성 — 재작성보다 점진적 확장을 선호한다.
- 에이전트 거버넌스 필요 — Worktree 룰 엔진처럼 새로운 보안 크리티컬 컴포넌트가 추가된다.

## Decision

### 1. TypeScript + Node.js + Express

기존 paperclip-orginal이 TypeScript 모노레포(packages/db, packages/adapters, server, ui)로 구성되어 있으며, 이 스택을 그대로 유지한다.

**선택 이유:**
- 포크 기반 프로젝트이므로 언어 전환 비용이 재작성 수준으로 불어난다.
- TypeScript의 정적 타입 시스템이 Drizzle ORM 스키마, API 응답 타입, 서비스 인터페이스 전반에 걸쳐 컴파일 타임 안전망을 제공한다.
- Node.js의 단일 스레드 이벤트 루프는 I/O 집약적 에이전트 오케스트레이션에 적합하다.
- Express는 미들웨어 체인 구성이 단순하여 `/maintenance/*` 접두어 게이트 같은 중앙화된 라우팅 제어에 적합하다.

**포기하는 것:** Go, Rust 같은 언어 대비 CPU 집약적 작업(Predicate 평가, HMAC 계산)에서 처리량 손실이 있을 수 있다. Worktree predicate 평가는 순수 함수이므로 필요 시 Worker Thread로 분리 가능하다.

### 2. Drizzle ORM (Prisma, TypeORM 대신)

**선택 이유:**
- 기존 paperclip-orginal이 Drizzle을 이미 사용 중이다 — 전환 비용 없음.
- Drizzle은 SQL에 가까운 쿼리 빌더 패턴을 사용하여 복잡한 쿼리(FOR UPDATE SKIP LOCKED, CTE, 조건부 인덱스)를 TypeScript 내에서 안전하게 표현할 수 있다.
- `db.execute(sql\`...\`)` 이스케이프 해치로 Raw SQL을 안전하게 삽입할 수 있어 스케줄러의 클레임-실행 패턴 구현에 필수적이다.
- Prisma 대비 런타임 overhead가 낮다(별도 데몬 없음, 쿼리 엔진 바이너리 불필요).
- TypeORM 대비 스키마가 코드-퍼스트로 단순하고, 마이그레이션 파일이 순수 SQL이라 DBA 검토가 용이하다.

**포기하는 것:** Prisma의 풍부한 생태계(Prisma Studio, 자동 관계 조회)를 사용할 수 없다. 복잡한 관계 조회는 명시적 조인 쿼리로 작성해야 한다.

### 3. PostgreSQL + FOR UPDATE SKIP LOCKED

**선택 이유:**
- 기존 paperclip이 PostgreSQL을 사용하며 fresh start이므로 DB 전환 이유가 없다.
- `FOR UPDATE SKIP LOCKED`는 스케줄러의 클레임-실행 패턴에 필수적이다. 복수의 서버 인스턴스가 동일한 schedules 레코드를 동시에 실행하는 상황을 DB 수준에서 방지한다. 애플리케이션 레벨 분산 락(Redis 등)이 필요 없다.
- `UNIQUE` 제약과 부분 인덱스(`WHERE enabled = true`)로 srb_nonces 중복 방지와 schedules 인덱스 최적화를 동시에 달성한다.
- JSONB 타입으로 Worktree 룰의 predicate와 decisionMap을 스키마 변경 없이 유연하게 저장한다.

**포기하는 것:** CockroachDB, PlanetScale 같은 분산 SQL은 `FOR UPDATE SKIP LOCKED` 지원이 제한적이거나 동작이 다르다. 수평 DB 샤딩이 필요해지면 스케줄러 설계를 재검토해야 한다.

### 4. re2 npm — $matches 프레디킷 ReDoS 방지 (CRITICAL)

Worktree 룰의 `$matches` 프레디킷 연산자는 반드시 `re2` npm 패키지를 사용해야 한다. 이것은 선택 사항이 아니라 필수 요구사항이다.

**이유:**
- JavaScript 기본 RegExp 엔진은 악의적으로 설계된 정규식에 대해 지수적 역추적(backtracking)이 발생할 수 있다 — ReDoS(Regular Expression Denial of Service) 공격이 가능하다.
- 에이전트가 제출하는 Worktree 룰 제안(worktree_rule_proposals)에 악성 정규식이 포함될 수 있다. 에이전트는 신뢰할 수 없는 입력원으로 간주해야 한다.
- `re2`는 Google의 RE2 라이브러리를 Node.js native addon으로 래핑한 패키지로, O(n) 선형 시간 보장을 제공한다. 역추적이 구조적으로 불가능하다.

**추가 보호 조치:**
- 패턴 길이 200자 제한 — re2 사용 여부와 무관하게 항상 적용
- 50ms 타임아웃 — re2의 O(n) 보장이 있더라도 길이 제한 초과 패턴에 대한 방어선

**위험:** re2는 native addon이므로 Node.js 버전·플랫폼 조합에 따라 바이너리 빌드가 실패할 수 있다. P4 착수 전 타겟 Node.js 버전에서 빌드 검증 필수. 빌드 실패 시 `$matches` 프레디킷 전체를 비활성화하고 `500 Internal Server Error` 반환 — unsafe fallback(기본 RegExp)은 허용되지 않는다.

### 5. prom-client + OpenTelemetry

**선택 이유:**
- `prom-client`는 Node.js 생태계에서 Prometheus 호환 메트릭 수집의 표준이다. 별도 에이전트 없이 `/metrics` HTTP 엔드포인트만으로 스크레이핑이 가능하다.
- OpenTelemetry는 벤더 중립적 추적 표준이다. 미래에 Jaeger, Tempo, Datadog 등으로 백엔드를 교체해도 계측 코드를 변경하지 않아도 된다.
- 두 라이브러리를 함께 사용하여 메트릭(집계)과 트레이스(개별 요청 추적)를 분리한다.

**SLI 계측 대상:**
- 스케줄러 due-to-wakeup 지연 (p95 < 90초)
- Worktree checkAction 지연 (p99 < 50ms)
- SRB webhook 전달률 (60초 내 > 99%)
- Mission 세션 재사용률 (> 80%)

**포기하는 것:** 단순한 배포에서는 prom-client + OTel 조합이 과도한 의존성으로 보일 수 있다. 하지만 Worktree MUST 룰 활성화 전 SLI 가시성이 필수적이므로 생략할 수 없다.

### 6. Telegram Bot API + Long Polling

**선택 이유:**
- papercompany는 Self-hosted 배포가 전제이다. 운영자가 NAT/방화벽 내부에 있을 수 있어 인바운드 HTTP 엔드포인트 노출이 어렵다.
- Long polling은 아웃바운드 HTTP 요청만 사용하므로 NAT/방화벽을 무력화할 수 있다.
- Telegram의 `getUpdates` API(`timeout=25`)는 long poll을 네이티브로 지원하며, 실제 지연은 1초 이내다.
- Webhook 전환이 필요해지면 `bot.ts`의 초기화 코드 한 곳만 변경하면 된다 — 커맨드 핸들러와 메시지 포매터 코드는 변경 없음.

**포기하는 것:** Webhook 대비 대규모 메시지 폭증 시 처리량이 낮다. 단일 long poll 루프이므로 병렬 업데이트 처리가 제한된다. v1 운영 규모에서는 문제가 되지 않을 것으로 판단한다.

## Consequences

### Positive
- 기존 paperclip 코드베이스와의 연속성이 유지되어 포크 오버헤드가 최소화된다.
- Drizzle + PostgreSQL의 조합으로 스케줄러 클레임 패턴, JSONB 프레디킷 저장, 부분 인덱스를 별도 인프라 없이 구현한다.
- re2로 ReDoS 위협을 구조적으로 제거한다 — 런타임 검사나 입력 필터링에 의존하지 않는다.
- Long polling으로 self-hosted 환경에서 추가 인프라(리버스 프록시, 공개 IP) 없이 Telegram 채널을 운영한다.

### Negative
- re2 native addon은 CI/CD 파이프라인과 Docker 이미지 빌드에 추가 복잡성을 야기한다. Node.js 버전 고정이 필요하다.
- Long polling은 Telegram 서버와 지속적인 연결을 유지하므로 네트워크 불안정 환경에서 재연결 로직이 필요하다.
- prom-client + OTel의 의존성 무게가 소규모 배포에서는 과도할 수 있다.

### Risks
- re2 빌드 실패 시 $matches 프레디킷이 전면 비활성화된다 — Worktree 룰의 일부 기능이 동작하지 않을 수 있다.
- Drizzle의 Raw SQL escape hatch를 남용할 경우 SQL injection 위험이 있다. `sql\`...\`` 템플릿 리터럴 외부에서 문자열 연결로 쿼리를 조합하는 것은 금지된다.
- prom-client와 OTel의 계측 코드가 핫패스(worktree.checkAction 등)에서 성능 저하를 일으킬 수 있다. 계측은 비동기로 수행하고 p99 < 50ms SLO를 지속적으로 모니터링한다.

## Enforcement

| 항목 | 강제 방법 |
|------|----------|
| re2 의무 사용 | `verify_all.sh V-03`: `predicate-eval.ts`의 import 목록에 `re2`가 존재하는지 grep 검증. CI에서 실패 시 빌드 블록. |
| re2 패턴 200자 제한 | `predicate-eval.ts` 내부에서 패턴 길이 체크 후 `400 Bad Request` 반환. 단위 테스트로 경계값 검증. |
| Drizzle Raw SQL 안전 사용 | ESLint 커스텀 룰 또는 코드 리뷰 체크리스트 — `sql\`...\`` 템플릿 리터럴 외 쿼리 문자열 조합 탐지. |
| prom-client `/metrics` 엔드포인트 | `verify_all.sh V-09`: `/metrics` HTTP 200 응답 + 4개 SLI 게이지 존재 확인. |
| Long polling 루프 재연결 | bot.ts 단위 테스트 — 네트워크 오류 시뮬레이션 후 polling 루프 복구 검증. |
