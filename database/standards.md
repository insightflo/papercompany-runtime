# papercompany DB 표준

**상태**: 승인됨  
**최초 작성**: 2026-04-01  
**적용 범위**: `packages/db/src/migrations/` 하위 모든 마이그레이션, drizzle ORM 스키마 정의, 서비스 계층 쿼리

---

## 목차

1. [테이블 명명 규칙](#1-테이블-명명-규칙)
2. [컬럼 명명 규칙](#2-컬럼-명명-규칙)
3. [인덱스 정책](#3-인덱스-정책)
4. [마이그레이션 규칙](#4-마이그레이션-규칙)
5. [쿼리 표준](#5-쿼리-표준)
6. [백업 & 복구 정책](#6-백업--복구-정책)
7. [Governance Operationalization](#7-governance-operationalization)

---

## 1. 테이블 명명 규칙

### 기본 규칙

| 규칙 | 올바른 예시 | 금지 패턴 |
|------|------------|-----------|
| snake_case | `user_profiles` | `userProfiles`, `UserProfiles` |
| 복수 명사 | `missions`, `agents`, `tools` | `mission`, `agent`, `tool` |
| 프리픽스 없음 (도메인 프리픽스 제외) | `companies` | `tbl_companies`, `t_companies` |
| PostgreSQL 예약어 회피 | `agent_sessions` | `sessions` |
| 약어 사용 금지 | `knowledge_bases` | `kb`, `knwl_base` |

### 도메인 프리픽스 규칙 (papercompany 전용)

특정 도메인은 서브시스템 경계를 명확히 하기 위해 프리픽스를 강제한다.

| 프리픽스 | 적용 도메인 | 예시 |
|----------|------------|------|
| `srb_*` | Service Request Bridge 관련 테이블 | `srb_links`, `srb_delivery_log`, `srb_nonces` |
| `mission_*` | Mission 연결 조인 테이블 | `mission_agents` |
| (없음) | 일반 도메인 엔티티 | `missions`, `agents`, `companies`, `tools` |

**근거**: `srb_*` 프리픽스는 SRB 서브시스템이 독립적으로 확장 또는 분리될 때 영향 범위를 즉시 식별하기 위함이다. `mission_*` 조인 테이블은 소유 엔티티(`missions`)와의 관계를 이름만으로 추론 가능하도록 한다.

---

## 2. 컬럼 명명 규칙

### 유형별 규칙

| 유형 | 규칙 | 예시 |
|------|------|------|
| Primary Key | `id` (UUID) | `id UUID DEFAULT gen_random_uuid()` |
| Foreign Key | `{참조테이블_단수}_id` | `company_id`, `agent_id`, `mission_id` |
| Boolean | `is_`, `has_`, `can_` 접두사 | `is_active`, `is_enabled`, `has_completed`, `can_propose` |
| 타임스탬프 | `_at` 접미사 + TIMESTAMPTZ | `created_at`, `updated_at`, `deleted_at`, `next_run_at` |
| JSON 페이로드 | `_data` 또는 `_config` 접미사 | `rule_config`, `context_data`, `step_data` |
| 열거형 상태 | `status` (단수, CHECK constraint) | `status TEXT CHECK (status IN (...))` |
| 배열 참조 | `_ids` 접미사 또는 조인 테이블 | 조인 테이블 우선 권장 |
| 해시 값 | `_hash` 접미사 | `nonce_hash`, `secret_hash` |
| 만료 시점 | `_expires_at` | `token_expires_at` |
| 카운터 | `_count` 접미사 | `retry_count`, `run_count` |

### 타임스탬프 표준

모든 테이블은 아래 세 컬럼을 포함한다:

```sql
-- 예시: 타임스탬프 컬럼 표준
created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at  TIMESTAMPTZ                         -- NULL = 활성, 소프트 삭제 지원 테이블에만
```

- `TIMESTAMPTZ` 사용 필수 — 타임존 없는 `TIMESTAMP` 금지
- `updated_at`은 애플리케이션 계층 또는 트리거에서 갱신 책임
- `deleted_at`은 소프트 삭제가 필요한 테이블에만 추가하며, 존재하는 경우 인덱스에 `WHERE deleted_at IS NULL` 조건 포함

### 금지 패턴 (papercompany 도메인 특수 규칙)

| 금지 패턴 | 이유 | 대체 방법 |
|-----------|------|----------|
| `session_token TEXT` 컬럼 직접 사용 | 평문 토큰 저장 금지 — 보안 정책 위반 | `session_secret_id TEXT REFERENCES company_secrets(id)` |
| `missions` 테이블에 `executor_ids TEXT[]` 배열 컬럼 | M:N 관계를 배열로 비정규화하면 조인·인덱스 불가 | `mission_agents` 조인 테이블 필수 |
| `status` 컬럼에 CHECK constraint 없이 자유 TEXT | 허용 상태값 범위 통제 불가 | `CHECK (status IN ('planning','active','paused','completed','cancelled'))` |

---

## 3. 인덱스 정책

### 명명 패턴

| 유형 | 패턴 | 예시 |
|------|------|------|
| Primary Key | `pk_{table}` | `pk_missions` |
| Foreign Key | `fk_{table}_{column}` | `fk_mission_agents_mission_id` |
| Unique | `uq_{table}_{column(s)}` | `uq_agents_slug`, `uq_srb_nonces_nonce_hash` |
| 일반 인덱스 | `idx_{table}_{column}` | `idx_missions_status` |
| 복합 인덱스 | `idx_{table}_{col1}_{col2}` | `idx_schedules_company_id_next_run_at` |
| 소프트 삭제 부분 인덱스 | `idx_{table}_{column}_active` | `idx_agents_company_id_active` |

### 인덱스 필수 생성 규칙

아래 케이스는 마이그레이션 PR에서 인덱스 누락이 Block 사유이다:

1. **모든 FK 컬럼**: 조회 방향에 따라 인덱스 필수
2. **`status` 컬럼**: 빈번한 상태 필터링이 예상되는 테이블 (missions, schedules, srb_delivery_log)
3. **`created_at`, `updated_at`**: 시계열 정렬 또는 TTL 기반 삭제 쿼리가 있는 경우
4. **`next_run_at` (schedules)**: 스케줄러 폴링의 핵심 쿼리 — 복합 인덱스 권장
5. **`srb_nonces.nonce_hash`**: Unique 인덱스 필수 — replay attack 방어의 기술적 보증 수단

```sql
-- 예시: schedules 테이블 인덱스
CREATE INDEX idx_schedules_next_run_at
  ON schedules (next_run_at)
  WHERE is_enabled = true;

-- 예시: srb_nonces 중복 방지
CREATE UNIQUE INDEX uq_srb_nonces_nonce_hash
  ON srb_nonces (nonce_hash);

-- 예시: 소프트 삭제 테이블의 부분 인덱스
CREATE INDEX idx_agents_company_id_active
  ON agents (company_id)
  WHERE deleted_at IS NULL;
```

### 인덱스 생성 시 주의사항

- 인덱스는 쓰기 성능에 영향을 미친다 — 실제 쿼리 패턴이 확인된 경우에만 추가
- 운영 중 인덱스 추가/삭제는 반드시 `CONCURRENTLY` 옵션 사용 (마이그레이션 규칙 §4 참조)
- 복합 인덱스의 컬럼 순서는 선택도(cardinality)가 높은 컬럼을 앞에 배치

---

## 4. 마이그레이션 규칙

### 파일명 규칙

```
{4자리_번호}_{snake_case_설명}.sql
```

예시:

```
0046_papercompany_core.sql
0047_add_mission_agents_table.sql
0048_add_srb_nonces_unique_index.sql
```

- 번호는 순차 증가, 건너뛰기 금지
- 설명은 변경 내용을 동사+목적어 형태로 기술 (`add_`, `drop_`, `alter_`, `create_`)
- 복수 변경이 논리적으로 묶이면 하나의 파일로 처리 가능, 단 파일명은 주요 변경 기준

### 마이그레이션 파일 필수 구조

```sql
-- Migration: {변경 내용 요약}
-- Created: {YYYY-MM-DD}
-- Author: {작성자 또는 에이전트 식별자}
-- Rollback: {번호}_{설명}_rollback.sql 또는 하단 주석 참조

-- ===== UP =====

{실제 DDL}

-- ===== ROLLBACK (참고용) =====
-- DROP TABLE IF EXISTS {table};
-- DROP INDEX CONCURRENTLY IF EXISTS {index};
```

Rollback 스크립트는 별도 파일(`{번호}_{설명}_rollback.sql`) 또는 마이그레이션 파일 하단 주석으로 제공한다.

### Zero-downtime 전략

운영 DB에 영향을 주는 변경은 아래 단계를 준수한다.

**컬럼 추가 (3단계)**

| 단계 | 작업 | 배포 |
|------|------|------|
| 1 | `ALTER TABLE ADD COLUMN col TEXT` (NOT NULL 없이) | 마이그레이션 단독 배포 |
| 2 | 백필 쿼리로 기존 row 데이터 채움 | 배치 쿼리, 대형 테이블은 배치 사이즈 조절 |
| 3 | `ALTER TABLE ALTER COLUMN col SET NOT NULL` | 코드 배포 이후 |

**컬럼 삭제 (2단계)**

| 단계 | 작업 | 배포 |
|------|------|------|
| 1 | 코드에서 해당 컬럼 참조 제거 | 코드 배포 |
| 2 | `ALTER TABLE DROP COLUMN col` | 다음 배포 또는 유지보수 윈도우 |

**인덱스 추가/삭제**

```sql
-- 추가
CREATE INDEX CONCURRENTLY idx_missions_status ON missions (status);

-- 삭제
DROP INDEX CONCURRENTLY IF EXISTS idx_missions_status;
```

`CONCURRENTLY`는 운영 테이블 lock을 발생시키지 않으나, 트랜잭션 블록 안에서 실행 불가이다. 마이그레이션 러너 설정에서 해당 파일을 트랜잭션 없이 실행하도록 처리해야 한다.

### 스테이징 우선 원칙

- 모든 마이그레이션은 스테이징 DB에서 먼저 실행하고, 정상 확인 후 프로덕션에 적용
- 마이그레이션 실행 시간이 30초를 초과하면 프로덕션 적용 전 DBA 검토 필수
- DDL 실행 로그와 소요 시간을 배포 기록에 남긴다

---

## 5. 쿼리 표준

### N+1 방지

drizzle ORM 사용 시:

```typescript
// 올바른 예시: with()로 관계 일괄 로드
const missions = await db.query.missions.findMany({
  with: {
    missionAgents: { with: { agent: true } },
  },
  where: eq(missions.companyId, companyId),
});

// 금지 예시: 루프 안에서 FK 조회 — N+1 발생
for (const mission of missions) {
  const agents = await db.query.missionAgents.findMany({ ... }); // 금지
}
```

Raw SQL에서 배치 처리가 필요한 경우 `JOIN` 또는 `WHERE id = ANY(:ids)` 형태를 사용한다.

### 페이지네이션

| 상황 | 방식 | 최대 limit |
|------|------|-----------|
| 기본 목록 API | Cursor 기반 | 100건 |
| 관리 목적 (어드민 UI) | Offset 허용 | 100건 |
| 10,000건 이상 데이터셋 | Cursor 필수 전환 | 100건 |

```sql
-- 올바른 예시: cursor 기반 페이지네이션
SELECT id, title, created_at
FROM missions
WHERE company_id = :company_id
  AND id > :cursor
  AND deleted_at IS NULL
ORDER BY id
LIMIT :limit;
```

런타임에서 `limit > 100` 요청은 강제로 100으로 클램핑한다.

### 트랜잭션 격리 수준

| 상황 | 격리 수준 | 사용 예시 |
|------|----------|----------|
| 기본 읽기/쓰기 | `READ COMMITTED` (PostgreSQL 기본값) | 일반 CRUD |
| 결제, 상태 전이, 재고 차감 | `REPEATABLE READ` | Mission 상태 변경, SRB 전달 확인 |
| 분산 동시성 제어 | `SELECT ... FOR UPDATE` | 스케줄러 claim-then-run |

```sql
-- 예시: 스케줄러 claim-then-run
BEGIN;
SELECT id FROM schedules
WHERE next_run_at <= now() AND is_enabled = true
ORDER BY next_run_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE schedules SET last_run_at = now(), next_run_at = :next
WHERE id = :id;
COMMIT;
```

### 타임아웃 설정

| 컨텍스트 | `statement_timeout` | 설정 방법 |
|----------|--------------------|-----------| 
| 일반 쿼리 | 30초 | 세션 레벨 또는 연결 풀 설정 |
| 배치 작업 | 120초 | 배치 작업 실행 전 명시적 SET |
| `srb_webhook` 처리 (nonce 검증 포함) | 10초 | 핸들러 진입 시 명시적 SET |

### 금지 패턴

| 패턴 | 이유 | 대체 |
|------|------|------|
| `SELECT *` | 불필요한 컬럼 네트워크 전송, 컬럼 추가 시 암묵적 인터페이스 변경 | 명시적 컬럼 목록 |
| Raw SQL을 단순 CRUD에 사용 | drizzle query builder로 타입 안전성 확보 가능 | `db.query.*` 또는 drizzle insert/update |
| 트랜잭션 없는 다중 상태 변경 | 부분 실패 시 데이터 불일치 | `db.transaction()` 래핑 |
| `WHERE 1=1` 동적 쿼리 조각 | SQL injection 위험, 쿼리 플래너 최적화 방해 | drizzle `and()` 조건 조합 |

Raw SQL은 복잡한 집계, CTE, Window Function 등 drizzle query builder가 표현하기 어려운 경우에만 허용한다.

---

## 6. 백업 & 복구 정책

### 정책 요약

| 항목 | 정책 |
|------|------|
| 전체 백업 (Full Backup) | 매일 오전 3시 KST |
| 증분 백업 (WAL 아카이브) | 1시간마다 |
| 보존 기간 | 30일 |
| 복구 테스트 | 월 1회 스테이징 DB 복원 테스트 |
| 목표 복구 시간 (RTO) | 4시간 이내 |
| 목표 복구 시점 (RPO) | 1시간 이내 |

### 백업 도구 및 경로

- `pg_dump` (전체 백업) + WAL-G 또는 Barman (WAL 아카이브) 권장
- 백업 파일은 서버 로컬이 아닌 외부 오브젝트 스토리지에 저장 (S3-compatible)
- 백업 파일 자체는 암호화 필수 (AES-256)

### 복구 테스트 절차

월 1회 스테이징 환경에서 아래를 검증한다:

1. 최신 전체 백업으로 복원 성공 여부
2. WAL 아카이브 적용 후 특정 시점 복구(PITR) 가능 여부
3. 복구 완료까지 소요 시간이 RTO(4시간) 이내인지 측정
4. 핵심 테이블(`missions`, `agents`, `srb_links`) row count 검증

### Fresh Start 주의사항

papercompany는 기존 paperclip 데이터 마이그레이션 없이 신규 DB로 시작한다. 백업 정책은 운영 트래픽이 시작되는 시점부터 적용하며, 초기 개발 단계에서는 스테이징 DB에 대해서만 일별 백업을 유지한다.

---

## 7. Governance Operationalization

표준 문서가 실제 코드에 강제되는 경로를 명확히 한다. 문서만 존재하고 검증이 없으면 표준은 형식화된다.

### 단일 진입 검증 명령

```bash
bash scripts/verify_all.sh
```

이 스크립트가 DB 표준 관련 검증의 단일 진입점이다. CI 파이프라인과 로컬 pre-commit 훅 모두 이 명령을 실행한다.

### DB 표준 강제 매핑

| DB 규칙 | 검증 위치 | 실행 명령 | 위반 시 처리 |
|---------|----------|----------|-------------|
| `session_token` plaintext 컬럼 금지 | `verify_all.sh` V-02 | `verify_all.sh` | **Block** (빌드 실패) |
| `mission_agents` 조인 테이블 분리 | `verify_all.sh` V-06 | `verify_all.sh` | **Block** (빌드 실패) |
| 마이그레이션 파일명 규칙 준수 | PR 리뷰 체크리스트 | 수동 확인 | **Warn** (리뷰어 지적) |
| FK 컬럼 인덱스 필수 | PR 리뷰 체크리스트 | 수동 확인 | **Warn** (리뷰어 지적) |
| `SELECT *` 금지 | ESLint `no-restricted-syntax` | `npx eslint . --quiet` | **Warn** |
| `TIMESTAMPTZ` 사용 강제 | PR 리뷰 체크리스트 | 수동 확인 | **Warn** |
| `CONCURRENTLY` 인덱스 DDL | PR 리뷰 체크리스트 | 수동 확인 | **Warn** |

### PR 리뷰 체크리스트 (마이그레이션 포함 PR)

마이그레이션 파일이 포함된 PR은 아래 항목을 리뷰어가 확인한다:

- [ ] 파일명이 `{4자리}_{snake_case}.sql` 형식인가
- [ ] 파일 상단에 `-- Migration:`, `-- Created:` 주석이 있는가
- [ ] Rollback 스크립트 또는 주석이 포함되어 있는가
- [ ] 모든 FK 컬럼에 인덱스가 생성되는가
- [ ] 운영 테이블 인덱스 추가/삭제에 `CONCURRENTLY`가 사용되었는가
- [ ] `TIMESTAMP` 대신 `TIMESTAMPTZ`를 사용했는가
- [ ] 새 상태 컬럼에 `CHECK constraint`가 정의되었는가
- [ ] 스테이징에서 사전 실행이 확인되었는가

### 표준 업데이트 트리거

이 문서는 아래 이벤트 발생 시 갱신한다:

- DB 장애 또는 성능 사고 사후 검토(postmortem) 완료 시
- 신규 도메인 테이블 패턴이 추가되어 명명 규칙 확장이 필요할 때
- PostgreSQL 버전 업그레이드로 인해 권장 옵션이 변경될 때
- `verify_all.sh`에 신규 검증 항목이 추가될 때

갱신 시 상단 `최초 작성` 아래에 `최종 수정: {날짜} — {변경 요약}` 줄을 추가한다.
