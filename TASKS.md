# TASKS.md

> Created: 2026-04-01
> Project: papercompany
> Base: paperclip-orginal (fork) — 이미 존재하는 코드 수정/추가만. 복사 불필요.
> Source: docs/plans/papercompany-architecture-plan.md

---

## P1 — Database Foundation

> Goal: 신규 테이블 생성 migration + Agent CLI 분리. 서비스 로직 없음.
> 시작점: `packages/db/src/schema/`, `packages/db/src/migrations/`

- [x] P1-T0: paperclip-orginal → papercompany 복사 (코드 베이스 세팅)
  - domain: infra | risk: low
  - cmd: `rsync -av --exclude node_modules --exclude dist --exclude .git --exclude paperclip-orginal /Users/kwak/Projects/paperclip/paperclip-orginal/ /Users/kwak/Projects/ai/papercompany/`
  - note: docs/ 양쪽 파일 내용 동일 확인됨 — 충돌 없음

- [x] P1-T0b: `scripts/verify_all.sh` 스텁 생성
  - domain: infra | risk: low | deps: P1-T0
  - note: 모든 거버넌스 문서가 이 파일을 단일 검증 진입점으로 참조함. P1 착수 직후 스텁 생성 후 각 Phase에서 V-* 항목 추가
  - creates: `scripts/verify_all.sh` (실행 권한 포함, V-01~V-10 placeholder 포함)

- [x] P1-T1: DB 마이그레이션 파일 작성 — `packages/db/src/migrations/0046_papercompany_core.sql`
  - domain: backend | risk: medium
  - 신규 테이블: missions, mission_agents, mission_sessions, workflow_definitions, workflow_runs, workflow_step_runs, tool_definitions, tool_audit_log, knowledge_bases, agent_kb_grants, schedules, worktree_rules, worktree_rule_proposals, worktree_audit_log, srb_links, srb_delivery_log, srb_nonces, channel_configs
  - ALTER: companies (+company_kind CHECK 'business'|'maintenance', +allows_code_modify)
  - note: OQ-4 missions 스키마 — owner_agent_id NOT NULL, status: planning|active|paused|completed|cancelled
  - note: session_token → company_secrets(id) 참조 (plaintext 저장 금지)
  - note: schedules에 partial index (WHERE enabled = true) — FOR UPDATE SKIP LOCKED 준비

- [x] P1-T2: Drizzle schema 파일 신규 생성 — `packages/db/src/schema/`
  - domain: backend | risk: low | deps: P1-T1
  - files (신규): missions.ts, mission_agents.ts, mission_sessions.ts, workflow_definitions.ts, workflow_runs.ts, workflow_step_runs.ts, tool_definitions.ts, tool_audit_log.ts, knowledge_bases.ts, agent_kb_grants.ts, schedules.ts, worktree_rules.ts, worktree_rule_proposals.ts, worktree_audit_log.ts, srb_links.ts, srb_delivery_log.ts, srb_nonces.ts, channel_configs.ts

- [x] P1-T3: `packages/db/src/schema/companies.ts` 수정 — company_kind, allows_code_modify 컬럼 추가
  - domain: backend | risk: low | deps: P1-T1

- [x] P1-T4: `packages/db/src/schema/index.ts` 수정 — 신규 테이블 export 추가
  - domain: backend | risk: low | deps: P1-T2

- [x] P1-T5: migration journal 업데이트 — `packages/db/src/migrations/meta/_journal.json`에 0046 entry 추가
  - domain: backend | risk: low | deps: P1-T1

- [x] P1-T6: Agent CLI 분리 — `packages/adapters/claude-local/src/server/execute.ts` 수정
  - domain: backend | risk: medium
  - 현재: CLAUDE_CONFIG_DIR 분리 없음 (execute.ts에 env 빌딩 로직 존재)
  - 추가: `env.CLAUDE_CONFIG_DIR = process.env.PAPERCLIP_AGENT_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude-agent')`
  - note: codex-local 등 다른 어댑터는 영향 없음

- [x] P1-T7: `scripts/setup-agent-config.sh` 작성
  - domain: infra | risk: low | deps: P1-T6
  - creates: `~/.claude-agent/settings.json` (빈 설정), `~/.claude-agent/.credentials.json` symlink

---

## P2 — Service Integration: Workflow + Tools + Knowledge

> Goal: 3개 플러그인 코드를 server services로 lift. PluginContext → db 직접 접근.
> 시작점: `packages/plugins/workflow-engine/src/`, `tool-registry/src/`, `knowledge-base/src/` (이미 존재)

- [x] P2-T1: `server/src/services/workflow/` 디렉토리 생성 + 파일 lift
  - domain: backend | risk: medium | deps: P1-T1
  - lift (복사 후 수정): dag-engine.ts, reconciler.ts, workflow-store.ts, workflow-utils.ts, run-guards.ts
  - 신규 작성: engine.ts (create/trigger/cancel API), types.ts (WorkflowDefinition, WorkflowRun, WorkflowStepRun)

- [x] P2-T2: reconciler.ts + workflow-store.ts PluginContext 의존성 제거
  - domain: backend | risk: high | deps: P2-T1
  - `ctx.entities.*`, `ctx.db.*` → Drizzle `db.*` 직접 호출
  - `ctx.issues.*` → `issuesService.*` 직접 호출

- [x] P2-T3: `server/src/services/tools/` 디렉토리 생성 + 파일 lift
  - domain: backend | risk: medium | deps: P1-T1
  - lift: audit.ts, tool-config.ts, adapters/
  - 신규: registry.ts (tool CRUD + dispatch), types.ts

- [x] P2-T4: `server/src/services/knowledge/` 디렉토리 생성 + 파일 lift
  - domain: backend | risk: medium | deps: P1-T1
  - lift: kb-store.ts
  - 신규: base.ts (KB CRUD + retrieval), types.ts

- [x] P2-T5: `server/src/services/index.ts` 수정 — 신규 서비스 wiring
  - domain: backend | risk: low | deps: P2-T1, P2-T3, P2-T4

- [x] P2-T6: 플러그인 deprecated 마킹 (로더에서 제외)
  - domain: backend | risk: low | deps: P2-T1, P2-T3, P2-T4
  - packages/plugins/workflow-engine, tool-registry, knowledge-base

- [x] P2-T7: 단위 테스트 — DAG validation, tool dispatch, KB retrieval
  - domain: backend | risk: medium | deps: P2-T2, P2-T3, P2-T4

---

## P3 — Scheduler Service

> Goal: cron 기반 에이전트 wakeup. 기존 heartbeat timer loop 의존 제거.
> 시작점: `server/src/services/cron.ts` (이미 존재 — 재사용)

- [x] P3-T1: `server/src/services/scheduler/cron-wakeup.ts` 구현
  - domain: backend | risk: high | deps: P1-T1
  - 기존 `cron.ts`의 파서 재사용 (nextRunAt 계산)
  - FOR UPDATE SKIP LOCKED claim-then-run 패턴 (플랜 §3.4 코드 그대로)
  - compute_next_run: TypeScript에서 계산 후 UPDATE (DB 함수 불필요)

- [x] P3-T2: `server/src/services/scheduler/types.ts` 작성
  - domain: backend | risk: low | deps: P3-T1

- [x] P3-T3: `server/src/app.ts` 수정 — scheduler polling loop 시작 (60s interval)
  - domain: backend | risk: medium | deps: P3-T1
  - note: createScheduler() 호출 및 start()로 시작. heartbeatService와 연동 완료

- [x] P3-T4: `server/src/routes/scheduler.ts` 신규 — schedules CRUD API
  - domain: backend | risk: low | deps: P3-T1
  - GET/POST /scheduler/schedules, PATCH/DELETE /scheduler/schedules/:id

- [x] P3-T5: `server/src/routes/index.ts` 수정 — scheduler 라우트 마운트
  - domain: backend | risk: low | deps: P3-T4
  - note: app.ts에서 직접 schedulerRoutes(db) 마운트

- [x] P3-T6: 테스트 — 5분/60분 cron 스케줄 동작 검증
  - domain: backend | risk: medium | deps: P3-T1
  - note: 서버 시작 후 scheduler.start()로 폴링 시작

---

## P4 — Worktree Harness

> Goal: MUST/SHOULD/MAY 룰 enforcement가 모든 tool invocation에 활성화.
> 시작점: 없음 (완전 신규)

- [x] P4-T1: `server/src/services/worktree/predicate-eval.ts` — 프레디킷 미니언어
  - domain: backend | risk: high
  - operators: $eq, $ne, $in, $notIn, $contains, $startsWith, $endsWith, $matches, $gt, $lt
  - CRITICAL: $matches → `re2` npm 패키지 사용 (ReDoS 방지, O(n))
  - CRITICAL: $matches 패턴 길이 200자 제한 + 50ms timeout

- [x] P4-T2: `server/src/services/worktree/harness.ts` — checkAction() 구현
  - domain: backend | risk: high | deps: P4-T1
  - MUST → WorktreeViolation throw | SHOULD → warning log | MAY → audit only

- [x] P4-T3: `server/src/services/worktree/rule-store.ts` — worktree_rules CRUD
  - domain: backend | risk: medium | deps: P1-T1

- [x] P4-T4: `server/src/services/worktree/proposal-store.ts` — 에이전트 proposal flow
  - domain: backend | risk: medium | deps: P1-T1
  - OQ-5: 에이전트당 하루 3건 per company 제한 서버에서 강제

- [x] P4-T5: `server/src/services/worktree/types.ts` 작성
  - domain: backend | risk: low

- [x] P4-T6: `server/src/services/tools/registry.ts`에 WorktreeHarness.check() 연결
  - domain: backend | risk: high | deps: P4-T2, P2-T3

- [x] P4-T7: `server/src/services/heartbeat.ts` 수정 — file-write, command-execute 포인트에 worktree check 추가
  - domain: backend | risk: high | deps: P4-T2

- [x] P4-T8: `server/src/middleware/company-kind-gate.ts` 신규
  - domain: backend | risk: critical | deps: P1-T3
  - CRITICAL: `app.use("/maintenance", requireMaintenanceCompany())` — per-route 절대 금지

- [x] P4-T9: `server/src/routes/worktree.ts` 신규 + `routes/index.ts` 수정
  - domain: backend | risk: low | deps: P4-T3, P4-T4, P4-T8
  - GET/POST /worktree/rules, PATCH /worktree/rules/:id
  - GET /worktree/proposals, PATCH /worktree/proposals/:id
  - /maintenance/* 하위 엔드포인트도 index.ts에서 일괄 마운트

- [x] P4-T10: 통합 테스트 — MUST/SHOULD/MAY 3개 티어 + predicate fuzz test
  - domain: backend | risk: medium | deps: P4-T2
  - CI 테스트: business-company JWT → /maintenance/* → 403 검증

---

## P5 — Mission Layer + Session Persistence

> Goal: Mission first-class entity. 에이전트 세션이 mission 범위로 유지.
> 시작점: heartbeat.ts (agentTaskSessions 로직 수정), issues.ts (mission_id FK 추가)

- [x] P5-T1: `server/src/services/missions.ts` 신규
  - domain: backend | risk: medium | deps: P1-T1
  - CRUD + issue tree + mission_agents 관리
  - OQ-4: owner_agent_id(PO 역할), executor/reviewer/observer/specialist role

- [x] P5-T2: `server/src/services/sessions/mission-session-store.ts` 신규
  - domain: backend | risk: medium | deps: P1-T1
  - OQ-2: 30일 idle timeout, company별 설정 가능
  - 만료 세션 접근 시 → 새 세션 생성 + 요약 노트를 첫 메시지로
  - `@paperclipai/adapter-utils`의 `resolveSessionCompactionPolicy` 재사용

- [x] P5-T3: `server/src/services/heartbeat.ts` 수정 — mission session 조회 분기 추가
  - domain: backend | risk: high | deps: P5-T2
  - missionId 있으면 mission_sessions[(missionId, agentId)] 조회
  - missionId 없으면 기존 agentTaskSessions 동작 유지 (하위 호환)

- [x] P5-T4: `server/src/services/issues.ts` 수정 — mission_id FK 지원
  - domain: backend | risk: medium | deps: P1-T1

- [x] P5-T5: `server/src/routes/missions.ts` 신규 + `routes/index.ts` 수정
  - domain: backend | risk: low | deps: P5-T1
  - GET/POST /missions, GET/PATCH/DELETE /missions/:id
  - GET /missions/:id/issues, GET /missions/:id/workflow-runs

- [ ] P5-T6: 테스트 — 동일 mission 3회 heartbeat → session token 재사용 검증
  - domain: backend | risk: medium | deps: P5-T3

---

## P6 — SRB Redesign

> Goal: same-instance(in-process) + cross-server(HTTP webhook) 두 경로.
> 시작점: packages/plugins/service-request-bridge/src/store.ts (PluginEntityRecord 기반 → redesign)

- [x] P6-T1: `server/src/services/srb/router.ts` — 경로 선택 로직
  - domain: backend | risk: medium | deps: P1-T1
  - remoteServerUrl == null → local | non-null → webhook

- [x] P6-T2: `server/src/services/srb/local-dispatch.ts` — in-process 경로
  - domain: backend | risk: high | deps: P6-T1
  - 단일 DB transaction: source event + target issue 동시 커밋

- [x] P6-T3: `server/src/services/srb/webhook-dispatch.ts` — HTTP webhook 발송
  - domain: backend | risk: high | deps: P6-T1
  - X-SRB-Timestamp (|now-ts|>300s 거부), X-SRB-Signature (HMAC-SHA256), X-SRB-Idempotency-Key
  - OQ-7: dual-secret 24h overlap window 지원

- [x] P6-T4: `server/src/routes/srb-webhook.ts` — POST /srb/webhook 수신 엔드포인트
  - domain: backend | risk: high | deps: P6-T3
  - HMAC 검증 + replay protection (srb_nonces unique constraint)

- [x] P6-T5: delivery retry worker — srb_delivery_log failed 레코드, exponential backoff, 최대 10회
  - domain: backend | risk: medium | deps: P6-T3

- [x] P6-T6: srb_nonces cleanup job — 10분 이상 된 nonce 삭제 (scheduler 활용)
  - domain: backend | risk: low | deps: P3-T1

- [x] P6-T7: service-request-bridge 플러그인 deprecated 마킹 + routes/index.ts 수정
  - domain: backend | risk: low | deps: P6-T1

---

## P7 — Telegram Channel

> Goal: Telegram bot이 유일한 human interaction 채널.
> 시작점: live-events.ts (이미 존재 — outbound notifier에 재사용)
> CRITICAL: worktree MUST 룰 활성화 전에 반드시 완료 (§12 Risk Register)

- [x] P7-T1: `server/src/channel/telegram/bot.ts` — long-poll 루프
  - domain: backend | risk: medium | deps: P1-T1
  - getUpdates timeout=25, offset tracking으로 중복 방지
  - OQ-3: long polling (v1), webhook 전환은 초기화 코드만 변경

- [x] P7-T2: `server/src/channel/telegram/commands.ts` — 커맨드 핸들러
  - domain: backend | risk: medium | deps: P7-T1, P5-T1
  - /status, /mission, /approve, /assign

- [x] P7-T3: `server/src/channel/telegram/formatter.ts` + `types.ts`
  - domain: backend | risk: low | deps: P7-T1

- [x] P7-T4: `server/src/channel/index.ts` — channel registry + 시작
  - domain: backend | risk: low | deps: P7-T1

- [x] P7-T5: outbound notifier — `live-events.ts` 구독 → Telegram 발송
  - domain: backend | risk: medium | deps: P7-T1
  - live-events.ts는 이미 존재 → 구독만 추가

- [x] P7-T6: Bot JWT lifecycle — 1시간 TTL, 만료 5분 전 재발급, channel_bot 역할
  - domain: backend | risk: medium | deps: P7-T1

- [x] P7-T7: `server/src/routes/channel.ts` 신규 + `routes/index.ts` 수정
  - domain: backend | risk: low | deps: P1-T1
  - GET/PUT /channel/config, POST /channel/test
  - bot_token → company_secrets 저장 (config_json 직접 저장 금지)

- [x] P7-T8: e2e 테스트 — Telegram으로 mission status 조회
  - domain: backend | risk: medium | deps: P7-T2

---

## P8 — UI Overhaul

> Goal: Mission 중심 UI. Issues가 primary nav에서 secondary로.
> 시작점: Issues.tsx, Goals.tsx, Dashboard.tsx, Sidebar.tsx 수정 + 신규 페이지 추가

- [x] P8-T1: `ui/src/pages/Missions.tsx` 신규 — mission 목록 + status chips
  - domain: frontend | risk: medium | deps: P5-T5

- [x] P8-T2: `ui/src/pages/MissionDetail.tsx` 신규 — issue tree + workflow panel + worktree panel
  - domain: frontend | risk: high | deps: P8-T1
  - sub-components: MissionIssueTree, WorkflowDagPanel, WorktreeRulePanel

- [x] P8-T3: `ui/src/pages/MissionCreate.tsx` 신규
  - domain: frontend | risk: medium | deps: P8-T1

- [x] P8-T4: `ui/src/components/MissionIssueTree.tsx` 신규 — nested issue tree
  - domain: frontend | risk: medium | deps: P8-T2

- [x] P8-T5: `ui/src/components/WorkflowDagPanel.tsx` 신규 — DAG 시각화
  - domain: frontend | risk: high | deps: P8-T2

- [x] P8-T6: `ui/src/pages/WorktreeRules.tsx` 신규 — 룰 목록 + form-based 빌더
  - domain: frontend | risk: high | deps: P4-T9
  - OQ-1: Option B(폼 빌더) + Raw JSON 파워유저 fallback

- [x] P8-T7: `ui/src/pages/WorktreeProposals.tsx` 신규 — 에이전트 제안 리뷰 UI
  - domain: frontend | risk: medium | deps: P4-T9

- [x] P8-T8: `ui/src/pages/SchedulerConfig.tsx` 신규
  - domain: frontend | risk: medium | deps: P3-T4

- [x] P8-T9: `ui/src/pages/ChannelConfig.tsx` 신규
  - domain: frontend | risk: medium | deps: P7-T7

- [x] P8-T10: `ui/src/components/Sidebar.tsx` 수정 — Missions primary, Issues secondary
  - domain: frontend | risk: low | deps: P8-T1

- [x] P8-T11: `ui/src/pages/Dashboard.tsx` 수정 — goal 요약 → mission 진행 요약
  - domain: frontend | risk: medium | deps: P8-T1

- [x] P8-T12: Goals primary nav 제거 (Settings 하위로 이동)
  - domain: frontend | risk: low | deps: P8-T10

---

## P9 — Observability

> Goal: 프로덕션 배포 전 필수. SLI/SLO + 알림.

- [x] P9-T1: prom-client 설치 + `/metrics` 엔드포인트 (Prometheus 호환)
  - domain: backend | risk: low

- [x] P9-T2: SLI 계측 — scheduler due-to-wakeup latency (p95 < 90s)
  - domain: backend | risk: medium | deps: P3-T1, P9-T1

- [x] P9-T3: SLI 계측 — worktree checkAction latency (p99 < 50ms)
  - domain: backend | risk: medium | deps: P4-T2, P9-T1

- [x] P9-T4: SLI 계측 — SRB webhook delivery rate (>99% within 60s)
  - domain: backend | risk: medium | deps: P6-T5, P9-T1

- [x] P9-T5: SLI 계측 — mission session reuse rate (>80%)
  - domain: backend | risk: low | deps: P5-T2, P9-T1

- [x] P9-T6: OpenTelemetry trace spans — worktree.checkAction, scheduler.claimAndWakeup, srb.route
  - domain: backend | risk: medium | deps: P4-T2, P3-T1, P6-T1

- [x] P9-T7: Audit log TTL cleanup job — worktree_audit_log(90d), tool_audit_log(90d), srb_delivery_log(30d), srb_nonces(10min)
  - domain: backend | risk: medium | deps: P3-T1

- [x] P9-T8: 추가 partial index — worktree_audit_log, srb_delivery_log, workflow_runs, mission_sessions (§15.3)
  - domain: backend | risk: low | deps: P1-T1

- [x] P9-T9: Telegram alert 룰 — scheduler down, SRB 연속 3회 실패, MUST block spike
  - domain: backend | risk: medium | deps: P7-T5, P9-T1

---

## 현황 요약

| Phase | 태스크 | 비고 |
|---|---|---|
| P1 — DB Foundation | 8 | P1-T0 복사 포함 |
| P2 — Workflow+Tools+KB | 7 | 플러그인 소스 이미 존재 |
| P3 — Scheduler | 6 | cron.ts 재사용 |
| P4 — Worktree Harness | 10 | 완전 신규 |
| P5 — Mission Layer | 6 | heartbeat.ts 수정 포함 |
| P6 — SRB Redesign | 7 | SRB store redesign |
| P7 — Telegram | 8 | live-events.ts 재사용 |
| P8 — UI Overhaul | 12 | 기존 페이지 수정 포함 |
| P9 — Observability | 9 | |
| **합계** | **73** | |

---

## Critical Constraints

1. **company_kind gate** → `/maintenance/*` prefix 전체에 한 번 (per-route 금지)
2. **session_token** → company_secrets 참조, plaintext 저장 금지
3. **$matches 프레디킷** → re2 npm 필수 (ReDoS 방지)
4. **Telegram 먼저 → Worktree MUST 활성화** (Risk Register §12)
5. **srb_nonces** → 10분 창 replay protection 필수
6. **OQ-4 missions 스키마** → owner_agent_id NOT NULL, mission_agents 조인 테이블 별도
7. **pi-local 어댑터** 제거 (papercompany 미포함)
8. **fresh start** — 기존 paperclip 데이터 마이그레이션 없음
