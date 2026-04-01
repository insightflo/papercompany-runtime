# papercompany 프로젝트 플랜

> 작성일: 2026-04-01
> 기준 문서: `docs/plans/papercompany-architecture-plan.md`, `TASKS.md`
> 형태: Solo developer + Claude Code assistance

---

## 1. 프로젝트 개요

### 목적

papercompany는 paperclip-orginal을 포크하여 만드는 **자율 에이전트 운영 플랫폼**이다. paperclip이 일반 목적의 에이전트 실행 프레임워크라면, papercompany는 워크플로우 오케스트레이션·도구 관리·지식 검색·실행 거버넌스·스케줄링 다섯 가지 핵심 역량을 서버 런타임에 직접 통합한 목적 지향 제품이다.

### 범위

| 영역 | 포함 | 미포함 |
|------|------|--------|
| 백엔드 | 9개 신규/수정 서비스, DB 마이그레이션, REST API | pi-local 어댑터 |
| 프론트엔드 | Mission 중심 UI 전면 개편 | Goals 독립 내비게이션 |
| 채널 | Telegram bot (long polling) | 웹 UI 계정 로그인 |
| 운영 | Prometheus 계측, OTel 추적, TTL 정리 잡 | 기존 paperclip 데이터 마이그레이션 |

**Fresh start 원칙**: 기존 paperclip 데이터 마이그레이션 없음. 신규 DB에서 시작.

### 성공 기준

1. **P1-P3 완료** — DB 마이그레이션, 워크플로우/도구/KB 서비스, 스케줄러가 테스트와 함께 동작.
2. **P4 완료** — Worktree MUST/SHOULD/MAY 룰이 모든 tool invocation에 적용되고, CI에서 business-company JWT가 `/maintenance/*` 엔드포인트에 403을 받음.
3. **P7 완료 후 P4 MUST 활성화** — Telegram이 운영 중인 상태에서만 MUST 블록 룰을 프로덕션에서 활성화.
4. **P9 완료** — SLI/SLO 계측, OTel 트레이스, Telegram 알림이 모두 동작하여 프로덕션 배포 준비 완료.
5. **전체 73개 태스크** 완료 및 `scripts/verify_all.sh` 통과.

---

## 2. 마일스톤

> 기준: 솔로 개발자 + Claude Code. 하루 ~4-6시간 실작업 기준.
> 태스크 수·복잡도·의존 관계를 반영한 추정값이며 ±20% 편차를 예상함.

| Phase | 목표 | 태스크 수 | 예상 기간 | 담당 역할 |
|-------|------|----------|----------|----------|
| **P1** — DB Foundation | 신규 테이블 마이그레이션 + Agent CLI 분리. 서비스 로직 없음. | 8 | 1.5주 | Backend + Infra |
| **P2** — Workflow + Tools + KB | 3개 플러그인 → 서버 서비스로 lift. PluginContext 제거. 단위 테스트. | 7 | 2주 | Backend |
| **P3** — Scheduler | cron 기반 에이전트 wakeup. heartbeat timer 의존 제거. | 6 | 1주 | Backend |
| **P4** — Worktree Harness | MUST/SHOULD/MAY 룰 enforcement + company_kind gate. 완전 신규. | 10 | 2주 | Backend |
| **P5** — Mission Layer | Mission 1등 엔티티 + 에이전트 세션 미션 범위로 유지. | 6 | 1.5주 | Backend |
| **P6** — SRB Redesign | same-instance(in-process) + cross-server(HTTP webhook) 두 경로. | 7 | 1.5주 | Backend |
| **P7** — Telegram Channel | Telegram bot 유일한 인간 상호작용 채널. **P4 MUST 활성화 전 필수 완료.** | 8 | 1.5주 | Backend |
| **P8** — UI Overhaul | Mission 중심 UI. 신규 페이지 7개 + 기존 수정. | 12 | 2.5주 | Frontend |
| **P9** — Observability | SLI/SLO 계측 + OTel 추적 + 알림 + TTL 정리. 프로덕션 배포 전 필수. | 9 | 1.5주 | Backend + Infra |
| **합계** | | **73** | **~15주** | |

### 전체 타임라인 (예상)

```
주차  1  2  3  4  5  6  7  8  9  10  11  12  13  14  15
     [P1──][P2──────][P3──][P4──────][P5──][P6──][P7──][P8──────][P9──]
```

> P7은 P4보다 늦게 끝나더라도 **MUST 룰 활성화만 P7 이후**로 지연시키면 됨.
> P8은 P5-P7과 병렬 진행 가능 (API 의존성만 완료되면).

---

## 3. 리스크 관리

### R-01 PluginContext 제거 (P2) — 높음

| 항목 | 내용 |
|------|------|
| **리스크** | `reconciler.ts`, `workflow-store.ts` 등이 `PluginContext`를 광범위하게 사용. 제거 시 기존 플러그인 통합 테스트 실패 가능. |
| **가능성** | 높음 |
| **영향** | 중간 — P2 일정 지연, 하위 호환성 파괴 |
| **완화** | ① P2 작업 전 기존 플러그인 테스트 전체 기록 → baseline 확보. ② `PluginContext`를 shimming 레이어로 래핑한 채 점진적으로 직접 `db` 호출로 교체. ③ 플러그인 deprecated 마킹은 테스트 통과 후에만 수행. |

### R-02 Worktree MUST 활성화 — Telegram 미완료 시 에이전트 차단 위험 — 높음

| 항목 | 내용 |
|------|------|
| **리스크** | MUST 룰 활성화 상태에서 Telegram이 없으면 에이전트가 차단되어도 인간이 즉각 인지·해제 불가. |
| **가능성** | 높음 (타임라인 압박 시) |
| **영향** | 높음 — 운영 중단 |
| **완화** | ① TASKS.md §P7 크리티컬 노트 그대로: **P7이 완료되어 Telegram bot이 운영 중인 상태에서만 MUST 룰 활성화.** ② P4에 dry-run 모드 구현(48시간 로깅만, 블록 없음) → MUST 룰은 dry-run 모드로 먼저 적용, Telegram 완료 후 enforcement 전환. ③ verify_all.sh에 "Telegram bot ping → MUST rules enforcement mode" 순서 체크 포함. |

### R-03 SRB 크로스 서버 HMAC 키 교체 — 보안/운영 위험 — 중간

| 항목 | 내용 |
|------|------|
| **리스크** | Dual-secret 24시간 overlap 창 운영 중 old 키가 예정보다 늦게 폐기되거나, 교체 중 webhook 검증 실패. |
| **가능성** | 중간 |
| **영향** | 높음 — cross-server SRB 전체 중단 |
| **완화** | ① `srb_links.shared_secret_id` 필드를 배열로 설계하여 두 키 동시 유효. ② 키 교체 절차를 `docs/ops/srb-key-rotation.md`에 명문화. ③ 교체 후 24시간 동안 `srb_delivery_log`에서 `failed` 건 수 모니터링 → Telegram alert. ④ P6 완료 시 키 교체 시나리오 통합 테스트 포함. |

### R-04 `re2` npm 의존성 ($matches 프레디킷) — 중간

| 항목 | 내용 |
|------|------|
| **리스크** | `re2` native addon은 Node.js 버전·플랫폼에 따라 바이너리 빌드 실패 가능. |
| **가능성** | 중간 (특히 CI/Docker 환경) |
| **영향** | 중간 — Worktree $matches 프레디킷 전체 비활성화 |
| **완화** | ① P4 착수 전 타겟 Node.js 버전에서 `re2` 빌드 검증. ② CI에 `re2` 설치 테스트 단계 추가. ③ 빌드 실패 시 `$matches`를 500ms timeout의 `vm.runInNewContext` fallback으로 비상 대체할 준비 (단, ReDoS 리스크 문서화 후 사용). ④ 패턴 길이 200자 제한은 `re2` 유무와 무관하게 항상 적용. |

### R-05 세션 만료 30일 idle 엣지 케이스 — 중간

| 항목 | 내용 |
|------|------|
| **리스크** | 장기 실행 미션(30일 이상)에서 idle 타임아웃이 예기치 않게 세션을 만료시켜 에이전트가 컨텍스트를 잃음. 또한 만료된 세션에 접근 시 생성되는 요약 노트가 어댑터 컨텍스트 한도에 걸릴 수 있음. |
| **가능성** | 중간 |
| **영향** | 높음 — 에이전트 업무 연속성 단절 |
| **완화** | ① Company별 idle timeout 설정 가능 (`company_configs` 또는 `channel_configs` 확장). ② `last_active_at` 갱신 로직이 모든 heartbeat run에서 일관되게 호출되는지 P5 테스트에서 검증. ③ 만료 7일 전 Telegram 경고 알림. ④ `resolveSessionCompactionPolicy` 재사용으로 컨텍스트 한도 초과 시 자동 compaction 트리거. |

### R-06 company_kind gate 우회 — 크리티컬

| 항목 | 내용 |
|------|------|
| **리스크** | 개발자가 `/maintenance/*` 하위 신규 라우트를 추가할 때 prefix 미들웨어 마운트 위치를 놓쳐 per-route 적용하거나 아예 누락. |
| **가능성** | 낮음 (아키텍처 constraint 명시) |
| **영향** | 크리티컬 — business company가 maintenance 기능에 접근 |
| **완화** | ① `routes/index.ts`에 `app.use("/maintenance", requireMaintenanceCompany())` 한 줄로 일괄 적용. Per-route 적용 절대 금지 규칙을 코드 주석 및 ADR에 명기. ② CI: business-company JWT → `GET /maintenance/*` → 403 검증 테스트. ③ verify_all.sh에 lint rule 포함: `/maintenance` 경로에 per-route requireMaintenanceCompany 호출 탐지. |

### R-07 플러그인 deprecated 이후 의존 경로 잔존 — 낮음

| 항목 | 내용 |
|------|------|
| **리스크** | P2-P6 플러그인 deprecated 마킹 후에도 서버 코드 어딘가에서 플러그인 store에 직접 접근하는 코드가 잔존. |
| **가능성** | 낮음 |
| **영향** | 중간 — 런타임 오류 |
| **완화** | 각 Phase 완료 시 `grep -r "packages/plugins/{plugin-name}"` 잔존 참조 확인을 verify_all.sh에 포함. |

---

## 4. 커뮤니케이션 규칙

### 4.1 채널

| 채널 | 용도 |
|------|------|
| **Telegram 회사 채널** | 에이전트 미션 상태 업데이트, Worktree SHOULD 경고, SRB 실패 알림, 스케줄러 다운 경고 |
| **GitHub Issues / PR** | 코드 리뷰, 버그 보고, Phase 완료 체크 |
| **TASKS.md** | 태스크 진행 상태 (checkbox 업데이트) |
| **management/decisions/** | ADR 및 아키텍처 결정 기록 |
| **`.claude/memory/`** | Claude Code 세션 간 컨텍스트 유지 |

### 4.2 보고 주기

| 주기 | 내용 |
|------|------|
| **Phase 완료 시** | TASKS.md 해당 Phase 전체 체크, `management/project-plan.md` 마일스톤 상태 업데이트 |
| **주간** | `.claude/memory/project.md` 최근 작업·남은 TODO 갱신 |
| **프로덕션 이벤트 발생 시** | Telegram → 장애 알림 → `management/incident-log.md` 기록 (원인파악→근본개선→재발방지 3단계) |

### 4.3 에이전트 팀 알림 규칙

- **Worktree SHOULD violation**: 위반 에이전트 + Telegram 회사 채널에 경고 발송
- **Worktree MUST violation**: 에이전트 run 즉시 중단 + Telegram 긴급 알림
- **SRB 연속 3회 실패**: Telegram High 알림 + `srb_delivery_log` 링크
- **스케줄러 120초 이상 미실행**: Telegram Critical 알림
- **Mission 상태 변경** (active → completed/cancelled): 관련 채널에 자동 통보

---

## 5. 에스컬레이션 정책

### 5.1 에스컬레이션 트리거

| 상황 | 심각도 | 즉각 조치 |
|------|--------|----------|
| Worktree MUST block이 비즈니스 크리티컬 에이전트를 차단 | High | Telegram으로 즉시 수동 개입 요청. 해당 룰 `enabled = false`로 임시 비활성화. 근본 원인 조사 후 룰 수정 또는 `decisionMap.alternatives` 추가. |
| SRB webhook 10회 재시도 모두 실패 (`abandoned`) | High | 대상 서버 연결 확인. `srb_links.shared_secret_id` 유효 여부 점검. 수동 재발송 또는 링크 재설정. |
| DB 마이그레이션 실패 | Critical | 즉시 롤백. 마이그레이션 SQL 검토 후 재적용. fresh start이므로 기존 데이터 손실 리스크 없음. |
| Telegram bot 60초 이상 오프라인 | High | 봇 프로세스 재시작. `channel_configs` 토큰 유효 여부 확인. |
| `company_kind` gate 우회 사례 발견 | Critical | 즉시 해당 라우트 수정 + CI에 회귀 테스트 추가 + ADR에 사례 기록. |

### 5.2 의사결정 권한

| 결정 유형 | 권한자 |
|----------|--------|
| Phase 일정 조정 (±1주 이내) | 개발자 자율 결정, TASKS.md 반영 |
| 아키텍처 변경 (새 ADR 필요) | `management/decisions/` ADR 작성 후 진행 |
| Critical Constraint 변경 | ADR + project-plan.md 섹션 3/6 동시 업데이트 필수 |
| 프로덕션 MUST 룰 활성화 | P7 완료 체크 + Telegram bot 동작 확인 후에만 허용 |

---

## 6. 거버넌스 운영화 (문서 → 실행)

### 6.1 단일 진입 검증 명령: `scripts/verify_all.sh`

```
scripts/verify_all.sh
```

이 스크립트는 프로젝트의 모든 거버넌스 아티팩트를 단일 명령으로 검증한다. CI에서 Phase 완료 시, 그리고 프로덕션 배포 직전 반드시 실행한다.

**검증 항목 목록:**

| 번호 | 항목 | 검증 방법 |
|------|------|----------|
| V-01 | company_kind gate 중앙화 | `routes/index.ts`에 `/maintenance` prefix 미들웨어 존재 + per-route 호출 부재 lint |
| V-02 | session_token plaintext 저장 금지 | `mission_sessions` 테이블에 `session_token` 컬럼 부재 (`session_secret_id` 참조만 허용) |
| V-03 | $matches → re2 사용 | `predicate-eval.ts` import에 `re2` 존재 확인 |
| V-04 | Telegram 완료 후 MUST 활성화 | `channel_configs` 레코드 존재 + `worktree_rules[severity=MUST, enabled=true]` 레코드가 있는 경우 bot ping 통과 여부 |
| V-05 | srb_nonces 10분 창 | `srb-webhook.ts`에서 `|now-ts| > 300s` 거부 로직 + cleanup job 존재 확인 |
| V-06 | mission_agents 조인 테이블 분리 | `missions` 테이블에 executor 배열 컬럼 부재 (`mission_agents` 조인 테이블로만 관리) |
| V-07 | 플러그인 deprecated 잔존 참조 없음 | `grep -r "packages/plugins/workflow-engine\|tool-registry\|knowledge-base\|service-request-bridge" server/src/` 결과 0 |
| V-08 | CI: business JWT → /maintenance/* → 403 | 통합 테스트 존재 + 통과 |
| V-09 | SLI 계측 엔드포인트 활성화 | `/metrics` HTTP 200 응답 + 4개 SLI 게이지 존재 확인 |
| V-10 | Audit log TTL cleanup 잡 등록 | `schedules` 테이블에 TTL 정리 cron 레코드 존재 |

### 6.2 거버넌스 아티팩트 매핑

| 아티팩트 | 위치 | 적용/강제 방법 |
|---------|------|---------------|
| **ADR** (아키텍처 결정 기록) | `management/decisions/adr-*.md` | 새 아키텍처 변경 시 ADR 작성 필수. verify_all.sh V-01~V-06이 각 ADR의 핵심 constraint를 코드 수준에서 검증. |
| **Quality Gates** | `management/quality-gates.md` (Phase 4 산출물) | 각 Phase 완료 체크리스트. CI에서 Phase PR 머지 전 통과 확인. |
| **DB Standards** | `database/standards.md` (Phase 5 산출물) | 마이그레이션 PR 리뷰 기준. 신규 테이블 PR에는 standards.md 체크리스트 리뷰 필수. |
| **Design System** | `design/system/` (Phase 3 산출물) | UI PR 리뷰 기준. P8 모든 신규 컴포넌트는 design system 토큰 사용 의무. |
| **Critical Constraints** | `TASKS.md §Critical Constraints`, 본 문서 섹션 3/6 | verify_all.sh 직접 검증. ADR 변경 없이 constraint 완화 금지. |

### 6.3 거버넌스 업데이트 트리거

다음 중 하나가 발생하면 관련 거버넌스 문서를 즉시 업데이트한다:

1. **새로운 아키텍처 결정** → `management/decisions/adr-{N}.md` 신규 작성
2. **Critical Constraint 변경 또는 추가** → `TASKS.md`, `management/project-plan.md` 섹션 3·6 동시 업데이트
3. **Phase 완료** → `TASKS.md` 체크박스 + `management/project-plan.md` 마일스톤 상태 업데이트
4. **운영 장애 발생** → `management/incident-log.md` 추가 + 관련 리스크 항목(섹션 3) 재평가
5. **verify_all.sh 신규 항목 추가** → 본 문서 섹션 6.1 표 동기화
6. **DB 스키마 변경** → `database/standards.md` 해당 테이블 항목 업데이트

---

## 부록 A: Critical Constraints 요약

아래 6가지 제약은 코드 어디서도 예외 없이 적용된다. 위반 시 verify_all.sh가 실패한다.

1. **company_kind gate** → `app.use("/maintenance", requireMaintenanceCompany())` 한 줄로만. Per-route 적용 절대 금지.
2. **session_token** → `company_secrets(id)` 참조만. plaintext 저장 금지.
3. **$matches 프레디킷** → `re2` npm 필수. 패턴 길이 200자 제한 + 50ms timeout.
4. **Telegram 먼저 → Worktree MUST 활성화** → P7 완료 + bot ping 통과 전 MUST 룰 `enabled = true` 금지.
5. **srb_nonces** → 10분 창 replay protection 필수. cleanup job 필수.
6. **mission_agents 조인 테이블** → `missions` 테이블에 executor 배열 컬럼 불가. 반드시 조인 테이블로 분리.

---

## 부록 B: 태스크 카운트 요약

| Phase | 태스크 수 | 도메인 비중 | 위험도 |
|-------|----------|-----------|--------|
| P1 | 8 | backend 6, infra 2 | medium×2, low×6 |
| P2 | 7 | backend 7 | high×1, medium×4, low×2 |
| P3 | 6 | backend 6 | high×1, medium×3, low×2 |
| P4 | 10 | backend 10 | critical×1, high×4, medium×3, low×2 |
| P5 | 6 | backend 6 | high×1, medium×4, low×1 |
| P6 | 7 | backend 7 | high×3, medium×2, low×2 |
| P7 | 8 | backend 8 | medium×5, low×3 |
| P8 | 12 | frontend 12 | high×3, medium×6, low×3 |
| P9 | 9 | backend 8, infra 1 | medium×6, low×3 |
| **합계** | **73** | | |
