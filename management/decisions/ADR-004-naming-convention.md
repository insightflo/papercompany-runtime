# ADR-004: 네이밍 규칙

## Status
Accepted

## Context

papercompany는 TypeScript 모노레포(packages/db, packages/adapters, server, ui)로 구성된다. 기존 paperclip-orginal 코드베이스를 포크하여 확장하므로 기존 컨벤션과의 일관성을 유지해야 한다. 동시에 이번 프로젝트에서 새롭게 추가되는 개념들(mission, worktree, company_kind, maintenance prefix, SRB 등)에 대한 명확한 네이밍 규칙이 필요하다.

일관된 네이밍은 다음 문제를 방지한다:
- 파일명 혼재(`camelCase.ts` vs `kebab-case.ts`)로 인한 import 오류(특히 대소문자를 구분하지 않는 macOS)
- DB 컬럼명과 TypeScript 속성명 불일치로 인한 Drizzle 쿼리 오류
- API 경로와 라우터 파일명의 불일치로 인한 라우팅 디버깅 어려움
- 상수와 변수를 구분하지 못해 발생하는 실수로 인한 런타임 오류

## Decision

### 1. 파일 네이밍

**백엔드 및 공유 패키지 (server/, packages/):**
- 모든 소스 파일: `kebab-case.ts`
  - 예: `cron-wakeup.ts`, `predicate-eval.ts`, `mission-session-store.ts`, `company-kind-gate.ts`
- 디렉토리: `kebab-case`
  - 예: `server/src/services/worktree/`, `server/src/channel/telegram/`
- 인덱스 파일: `index.ts` (소문자)
- 타입 정의 파일: `types.ts` (서비스별 디렉토리 내부)

**React UI (ui/):**
- 페이지 컴포넌트: `PascalCase.tsx`
  - 예: `Missions.tsx`, `MissionDetail.tsx`, `WorktreeRules.tsx`, `ChannelConfig.tsx`
- 재사용 컴포넌트: `PascalCase.tsx`
  - 예: `MissionIssueTree.tsx`, `WorkflowDagPanel.tsx`, `WorktreeRuleForm.tsx`
- 유틸리티/훅: `kebab-case.ts` 또는 `camelCase.ts` (기존 코드베이스 관례 유지)
- 페이지 파일과 컴포넌트 파일 모두 `PascalCase.tsx` — 구분은 디렉토리(`pages/` vs `components/`)로 한다.

**마이그레이션 및 스크립트:**
- SQL 마이그레이션: `{숫자4자리}_{설명_snake_case}.sql`
  - 예: `0046_papercompany_core.sql`
- 셸 스크립트: `kebab-case.sh`
  - 예: `setup-agent-config.sh`, `verify_all.sh` (기존 관례 유지)

### 2. DB 테이블 및 컬럼 네이밍

**테이블명:**
- `snake_case` 복수형
  - 예: `missions`, `mission_agents`, `worktree_rules`, `worktree_audit_log`, `srb_links`, `channel_configs`

**컬럼명:**
- `snake_case`
  - 예: `company_id`, `owner_agent_id`, `next_run_at`, `adapter_type`, `config_json`
- 타임스탬프 컬럼: `{동사}_at` 패턴
  - 생성: `created_at`, 수정: `updated_at`, 만료: `expires_at`, 마지막 활동: `last_active_at`
- Boolean 컬럼: `{형용사}` 또는 `is_{형용사}` — 기존 paperclip 관례 따름 (`enabled`, `allows_code_modify`)
- Foreign key 컬럼: `{참조_테이블_단수}_{id 또는 필드명}`
  - 예: `company_id` (companies 참조), `agent_id` (agents 참조), `session_secret_id` (secrets 참조)

**인덱스명:**
- 타입 접두어 + 테이블명 + 컬럼명 패턴 (`database/standards.md §3` 기준)
  - PK: `pk_{table}` — 예: `pk_missions`
  - FK: `fk_{table}_{column}` — 예: `fk_mission_agents_mission_id`
  - Unique: `uq_{table}_{column}` — 예: `uq_srb_nonces_nonce_hash`
  - 일반: `idx_{table}_{column}` — 예: `idx_missions_status`, `idx_schedules_next_run_at`
  - 복합: `idx_{table}_{col1}_{col2}` — 예: `idx_schedules_company_id_next_run_at`
- 소프트 삭제 부분 인덱스: `idx_{table}_{column}_active` — 예: `idx_agents_company_id_active`

**CHECK 제약:**
- 테이블명과 컬럼명을 조합
  - 예: 별도 이름 불필요 — Drizzle이 자동 생성. 필요 시 `{테이블}_{컬럼}_check`

### 3. TypeScript 네이밍

**변수 및 함수:**
- `camelCase`
  - 예: `companyId`, `nextRunAt`, `checkAction`, `routeSRBRequest`

**타입 및 인터페이스:**
- `PascalCase`
  - 예: `WorktreeCheckResult`, `MissionSession`, `SRBRequest`, `ToolDefinition`
- 인터페이스 이름에 `I` 접두어 사용 금지 (`IWorktreeCheckResult` 아닌 `WorktreeCheckResult`)

**클래스:**
- `PascalCase`
  - 예: `TelegramBot`, `WorktreeHarness`

**열거형(enum):**
- 타입: `PascalCase`
- 값: `SCREAMING_SNAKE_CASE`
  - 예: `enum CompanyKind { BUSINESS = "business", MAINTENANCE = "maintenance" }`
- 또는 as const 객체를 선호 (런타임 값 제어 명확):
  - 예: `const SEVERITY = { MUST: "MUST", SHOULD: "SHOULD", MAY: "MAY" } as const`

**상수:**
- 모듈 레벨 불변 값: `SCREAMING_SNAKE_CASE`
  - 예: `MAX_PATTERN_LENGTH = 200`, `NONCE_WINDOW_SECONDS = 300`, `SCHEDULER_POLL_INTERVAL_MS = 60_000`
- 지역 변수는 `camelCase`로 충분하다 — 상수성이 중요한 경우에만 `SCREAMING_SNAKE_CASE` 적용

**오류 코드:**
- `SCREAMING_SNAKE_CASE` 문자열 상수 (ADR-003 참조)
  - 예: `WORKTREE_VIOLATION`, `SRB_HMAC_INVALID`, `MAINTENANCE_COMPANY_REQUIRED`

**Drizzle 스키마 변수:**
- 테이블: `camelCase`로 선언하되 실제 테이블명은 snake_case 문자열로 지정
  - 예: `export const missions = pgTable("missions", { ... })`
- 컬럼: camelCase 속성명, 실제 컬럼명은 `.("snake_case_name")` 또는 Drizzle 자동 변환
  - 예: `ownerId: text("owner_agent_id").notNull()`

### 4. API 엔드포인트 네이밍

**REST 리소스 경로:**
- `kebab-case` 복수 명사
  - 예: `/api/v1/missions`, `/api/v1/worktree-rules`, `/api/v1/srb-links`
- ID 파라미터: `/:id` (단순 리소스) 또는 `/:missionId` (중첩 컨텍스트)
  - 예: `/api/v1/missions/:id`, `/api/v1/missions/:missionId/issues`
- 액션(동사): 가능하면 HTTP 메서드로 표현. 불가피한 경우 `/{명사}/{액션}` 형식
  - 예: `/api/v1/channel/test` (POST — 테스트 메시지 발송)

**maintenance 전용 경로:**
- `/maintenance/{리소스}/{액션}` 형식
- 모든 `/maintenance/*` 경로는 `requireMaintenanceCompany()` 미들웨어가 일괄 보호
  - 예: `/maintenance/worktree/rules`, `/maintenance/tools/builtins`, `/maintenance/agents/:id/code`

**SRB 웹훅:**
- `/srb/webhook` — 동사 없음, 버전 없음 (X-SRB-Protocol-Version 헤더로 버전 관리)

**Prometheus 메트릭:**
- `/metrics` — 버전 없음, 표준 Prometheus 경로

### 5. 서비스 및 미들웨어 네이밍

**서비스 파일:**
- `server/src/services/{도메인}/` 디렉토리 아래 `{기능}.ts`
  - 예: `services/worktree/harness.ts`, `services/scheduler/cron-wakeup.ts`, `services/srb/router.ts`
- 루트 레벨 단일 파일 서비스: `services/{도메인}.ts`
  - 예: `services/missions.ts`, `services/heartbeat.ts`

**미들웨어:**
- `server/src/middleware/{기능}.ts`
  - 예: `middleware/company-kind-gate.ts`
- 미들웨어 팩토리 함수: `require{조건}()` 또는 `check{조건}()` 패턴
  - 예: `requireMaintenanceCompany()`, `requireCompanyScope()`

**라우터 파일:**
- `server/src/routes/{리소스}.ts`
  - 예: `routes/missions.ts`, `routes/worktree.ts`, `routes/srb-webhook.ts`
- 파일명과 해당 라우터가 마운트되는 경로를 일치시킨다
  - `routes/worktree.ts` → `app.use("/api/v1/worktree", worktreeRoutes)`

**채널 파일:**
- `server/src/channel/{채널명}/{기능}.ts`
  - 예: `channel/telegram/bot.ts`, `channel/telegram/commands.ts`

### 6. 특수 케이스 및 예외

**약어 처리:**
- 잘 알려진 약어는 전체 대문자를 유지한다: `SRB`, `KB`, `DB`, `JWT`, `HMAC`, `DAG`
- TypeScript 타입명에서: `SRBRequest`, `KBRetrievalResult`, `HMACSignature`
- 파일명에서: `srb-router.ts`, `kb-store.ts` (파일명은 kebab-case이므로 소문자)

**company_kind 관련:**
- DB 컬럼: `company_kind` (snake_case)
- TypeScript 타입: `companyKind: "business" | "maintenance"` (camelCase 속성, 리터럴 타입)
- 미들웨어: `requireMaintenanceCompany()` (함수명은 camelCase)
- API 경로: `/maintenance/*` (kebab-case)

**Drizzle 관계 타입:**
- 테이블 간 관계를 나타내는 타입은 `With{관계명}` 패턴
  - 예: `MissionWithAgents`, `WorktreeRuleWithProposals`

## Consequences

### Positive
- 파일 위치만 보고 용도를 예측할 수 있다 (`routes/` → 라우터, `services/` → 비즈니스 로직, `middleware/` → 미들웨어).
- React 컴포넌트(PascalCase)와 비 컴포넌트(kebab-case)를 파일명만으로 구분할 수 있어 import 오류를 줄인다.
- DB 컬럼(snake_case)과 TypeScript 속성(camelCase)의 매핑 규칙이 명확하여 Drizzle 스키마 작성 시 실수를 줄인다.
- SCREAMING_SNAKE_CASE 상수가 일반 변수와 시각적으로 구분되어 런타임 변경 가능성을 코드에서 명시한다.

### Negative
- 규칙이 세분화되어 있어 새 기여자가 모든 케이스를 암기하기 어렵다. 린터 도움이 필요하다.
- 기존 paperclip-orginal 코드 중 이 규칙을 따르지 않는 부분이 있을 수 있다. 새로 작성하는 코드에만 엄격하게 적용하고, 기존 코드는 수정 시 점진적으로 맞춘다.

### Risks
- ESLint 규칙이 모든 네이밍 케이스를 자동으로 감지하지 못한다 (특히 파일명 규칙). 코드 리뷰에서 보완해야 한다.
- 약어 처리 규칙(`SRB` vs `srb`)이 일관되게 적용되지 않으면 import 경로가 혼재된다. PR 리뷰 체크리스트에 약어 케이스 항목을 포함한다.

## Enforcement

| 항목 | 강제 방법 |
|------|----------|
| TypeScript camelCase/PascalCase/SCREAMING_SNAKE | ESLint `@typescript-eslint/naming-convention` 룰 설정. CI에서 lint 실패 시 빌드 블록. |
| React 컴포넌트 PascalCase.tsx | ESLint `react/jsx-pascal-case` 룰. |
| 파일명 kebab-case (백엔드) | ESLint `unicorn/filename-case` 룰 (`kebabCase: true`). UI는 `pascalCase: true` 설정. |
| DB 컬럼 snake_case | Drizzle 스키마 PR 리뷰 — `.("컬럼명")` 문자열에서 camelCase 사용 시 차단. |
| API 경로 kebab-case | 라우터 파일 PR 리뷰 + 통합 테스트의 엔드포인트 경로 문자열 검토. |
| maintenance 경로 일관성 | `verify_all.sh V-01`: `/maintenance` prefix 미들웨어 존재 확인. |
| 오류 코드 SCREAMING_SNAKE | `ERROR_CODES` 상수 객체 중앙화 — 분산된 문자열 리터럴 사용 금지. TypeScript 타입에서 `keyof typeof ERROR_CODES`로 강제. |
