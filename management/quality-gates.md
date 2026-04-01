# Quality Gates

> 작성일: 2026-04-01
> 프로젝트: papercompany
> 형태: 측정 가능한 품질 기준과 체크리스트만 포함. 구현 코드 없음.
> 관련 문서: `management/project-plan.md §6`, `TASKS.md §Critical Constraints`

---

## 0. 거버넌스 운영화 (문서 → 실행)

### 단일 진입 검증 명령

```
scripts/verify_all.sh
```

모든 품질 게이트는 이 스크립트 하나로 진입한다. CI에서 Phase 완료 PR 머지 전, 그리고 프로덕션 배포 직전 반드시 실행한다.

### 게이트 항목 매핑

| 게이트 항목 | 실행 명령 / CI 잡 | 아티팩트 경로 | Block / Warn |
|------------|-----------------|--------------|:------------:|
| TypeScript strict 오류 | `npx tsc --noEmit` | `tsc-output.txt` | **Block** |
| ESLint 오류 | `npx eslint . --quiet` | `eslint-output.txt` | **Block** |
| 유닛 테스트 커버리지 | `npx vitest run --coverage` | `coverage/lcov.info` | **Block** (80% 미만 시) |
| Critical Constraints V-01~V-10 | `scripts/verify_all.sh` | `verify-report.txt` | **Block** |
| npm 보안 취약점 (Critical/High) | `npx audit-ci --critical` | `audit-output.json` | **Block** |
| 페이지 LCP (성능) | Lighthouse CI | `lhci-report.json` | **Warn** |

### 거버넌스 업데이트 트리거

다음 중 하나가 발생하면 이 문서를 즉시 업데이트한다:

1. 새 public API 추가 — Critical API 목록(섹션 1) 검토 및 갱신
2. verify_all.sh 항목 추가 또는 변경 — 섹션 5 표와 동기화
3. 반복 실패 게이트 항목 — 임계값 또는 측정 방법 재평가
4. 보안 사고 발생 — 섹션 4 항목에 재발 방지 기준 추가
5. Phase 완료 — 해당 Phase 특별 조건(섹션 7) 이행 여부 확인

---

## 1. 테스트 커버리지 기준

| 유형 | 목표 | 측정 방법 |
|------|:----:|----------|
| 유닛 테스트 | ≥ 80% | `npx vitest run --coverage` — lcov 기준 |
| 통합 테스트 | 100% (Critical API) | supertest + 실제 DB (테스트 컨테이너) |
| E2E 테스트 | 100% (Critical Path) | Playwright |

### Critical API 목록

papercompany 도메인에서 100% 통합 테스트 커버리지를 요구하는 엔드포인트:

| 엔드포인트 | 검증 포인트 | 연관 게이트 |
|-----------|-----------|-----------|
| `POST /agents/:id/run` | 에이전트 실행, Worktree 룰 적용 여부 | V-04 |
| `POST /workflows` | 워크플로우 생성, DAG 검증 | — |
| `GET /maintenance/*` (business JWT) | HTTP 403 응답 | V-01, V-08 |
| `POST /srb/webhook` | nonce 검증, HMAC 서명, replay 거부 | V-05 |
| `POST /schedules` | cron 표현식 유효성, DB 레코드 생성 | — |

### Critical Path (E2E)

100% 커버리지를 요구하는 사용자 시나리오:

1. Mission 생성 → 에이전트 할당(`mission_agents`) → 실행 → 상태(`active`/`completed`) 확인
2. Worktree MUST 룰 위반 시 에이전트 run 즉시 차단, Telegram 긴급 알림 발송 확인
3. SRB webhook 전송 → `srb_delivery_log` 성공 레코드 생성 확인

---

## 2. 코드 품질 기준

| 메트릭 | 임계값 | 측정 도구 |
|--------|:------:|---------|
| ESLint 오류 | 0 | `npx eslint . --quiet` |
| TypeScript strict 오류 | 0 | `npx tsc --noEmit` |
| 순환 복잡도 | ≤ 10 (함수 단위) | ESLint `complexity` rule |
| 코드 중복 | ≤ 5% | `jscpd --min-lines 5` |
| npm 취약점 (Critical/High) | 0 | `npx audit-ci --critical` |

---

## 3. 성능 기준

| 메트릭 | 목표 | 측정 방법 |
|--------|:----:|---------|
| API 응답 시간 (P95) | ≤ 200ms | 통합 테스트 타이머 (`supertest` + 응답 시간 assertion) |
| 에이전트 실행 시작 지연 | ≤ 500ms | `POST /agents/:id/run` 응답 → 첫 번째 heartbeat 간격 측정 |
| 스케줄러 wake-up 지연 | ≤ 5s | cron 예약 시각 대비 실제 실행 시각 차이 (heartbeat 로그 기준) |
| 페이지 LCP | ≤ 2.5s | Lighthouse CI (`lhci autorun`) |
| 번들 크기 (gzip) | ≤ 500KB | `vite-bundle-visualizer` + CI 빌드 아티팩트 |

---

## 4. 보안 기준

모든 항목은 단일 통과/실패 기준이다. 예외 없음.

| 기준 | 검증 방법 | 연관 게이트 |
|------|---------|-----------|
| OWASP Top 10 스캔 통과 | `npx audit-ci --critical` — CVSS High/Critical 0건 | — |
| npm 취약점 (Critical/High) 0건 | `npm audit --audit-level=high` 종료 코드 0 | — |
| `session_token` plaintext 저장 금지 | `verify_all.sh` V-02 — `mission_sessions` 테이블에 `session_token` 컬럼 부재 확인 | V-02 |
| `company_kind` gate 우회 없음 | `verify_all.sh` V-01 — per-route `requireMaintenanceCompany` 호출 lint + prefix 미들웨어 존재 확인 | V-01 |
| SRB nonce replay protection | `verify_all.sh` V-05 — 10분 창 거부 로직 + cleanup job 존재 확인 | V-05 |
| 시크릿/환경변수 하드코딩 금지 | `git-secrets` 또는 `truffleHog` — CI 커밋 전 스캔 | — |

---

## 5. Critical Constraints 게이트 (verify_all.sh V-01~V-10)

`project-plan.md §6.1`에 정의된 V-01~V-10 항목의 검증 기준표.

| 번호 | 항목 | 검증 방법 요약 | Pass 기준 | 심각도 |
|:----:|------|--------------|:--------:|:------:|
| V-01 | company_kind gate 중앙화 | `routes/index.ts`에 `/maintenance` prefix 미들웨어 존재 확인 + per-route 호출 lint로 0건 확인 | 미들웨어 존재 AND per-route 호출 0건 | Critical |
| V-02 | session_token plaintext 저장 금지 | `mission_sessions` 테이블 스키마에 `session_token` 컬럼 부재, `session_secret_id` FK 참조 확인 | `session_token` 컬럼 0개 | Critical |
| V-03 | $matches → re2 사용 | `predicate-eval.ts`의 import 목록에 `re2` 존재 확인 | import 존재 AND 패턴 길이 200자 제한 코드 존재 | High |
| V-04 | Telegram 완료 후 MUST 활성화 | `channel_configs` 레코드 존재 확인 + `worktree_rules[severity=MUST, enabled=true]` 레코드 있을 경우 Telegram bot ping 통과 여부 | MUST 활성화 시 bot ping HTTP 200 | Critical |
| V-05 | srb_nonces 10분 창 | `srb-webhook.ts`에 `now - ts > 300s` 거부 로직 존재 + `schedules`에 nonce cleanup cron 존재 | 거부 로직 AND cleanup job 모두 존재 | High |
| V-06 | mission_agents 조인 테이블 분리 | `missions` 테이블 스키마에 executor 배열 컬럼 부재 확인 + `mission_agents` 테이블 존재 확인 | `missions`에 배열 컬럼 0개 | High |
| V-07 | 플러그인 deprecated 잔존 참조 없음 | `grep -r "packages/plugins/{workflow-engine,tool-registry,knowledge-base,service-request-bridge}" server/src/` 결과 0건 | 잔존 참조 0건 | Medium |
| V-08 | CI: business JWT → /maintenance/* → 403 | 통합 테스트 파일 존재 + 해당 테스트 통과 | 테스트 존재 AND 통과 | Critical |
| V-09 | SLI 계측 엔드포인트 활성화 | `/metrics` HTTP 200 응답 + 4개 SLI 게이지(레이턴시, 에러율, 스케줄러 지연, SRB 실패율) 존재 확인 | 4개 게이지 모두 존재 | Medium |
| V-10 | Audit log TTL cleanup 잡 등록 | `schedules` 테이블에 TTL 정리 cron 레코드 존재 확인 | 레코드 존재 | Low |

---

## 6. 코드 리뷰 체크리스트

Phase PR 머지 전 리뷰어가 직접 확인하는 항목. 각 항목은 체크 또는 N/A로만 처리한다.

### 기본 (모든 PR)

- [ ] 요구사항이 TASKS.md 태스크와 1:1 대응
- [ ] 유닛 테스트 또는 통합 테스트 포함
- [ ] `npx tsc --noEmit` 오류 0개
- [ ] `npx eslint . --quiet` 오류 0개
- [ ] 변경 내용이 해당 ADR 또는 `project-plan.md` 제약과 충돌하지 않음
- [ ] 문서 업데이트 필요 시 (`management/`, `TASKS.md`) 동시 반영

### 보안 (백엔드 PR)

- [ ] SQL 인젝션 위험 없음 — Drizzle ORM 파라미터화 쿼리 또는 `db.execute(sql.raw)` 미사용 확인
- [ ] 새 라우트가 `/maintenance` 하위면 prefix 미들웨어로 커버 확인 (per-route 적용 없음)
- [ ] 로그에 민감 데이터(session token, HMAC key, 사용자 입력) 미포함
- [ ] `session_token` plaintext 저장 없음 — `session_secret_id` FK만 허용

### Critical Constraint (해당 PR)

- [ ] V-01~V-10 중 이 PR과 관련된 항목 수동 확인 (번호 명시)
- [ ] 로컬에서 `scripts/verify_all.sh` 실행 후 통과 확인

### 성능 (Critical API 또는 DB PR)

- [ ] N+1 쿼리 없음 — 관계 데이터 조회는 JOIN 또는 배치 로드
- [ ] 새 DB 쿼리에 인덱스 필요 여부 검토 (`EXPLAIN ANALYZE` 결과 첨부 권장)
- [ ] `schedules` 테이블 쿼리는 `WHERE enabled = true` partial index 활용 확인

### 프론트엔드 (UI PR, P8)

- [ ] design system 토큰 사용 — 임의 HEX 색상 코드 없음
- [ ] ARIA 레이블 및 포커스 ring 적용 (접근성)
- [ ] Tailwind CSS 클래스만 사용, 인라인 style 없음

---

## 7. Phase 완료 승인 기준

Phase PR을 `completed`로 전환하려면 아래 조건을 모두 충족해야 한다.

| 조건 | 확인 방법 |
|------|---------|
| 해당 Phase의 모든 태스크 체크 완료 | `TASKS.md` — 해당 Phase 내 unchecked 항목 0개 |
| `scripts/verify_all.sh` 통과 | 스크립트 종료 코드 0 + `verify-report.txt` 첨부 |
| 유닛 테스트 커버리지 ≥ 80% | `npx vitest run --coverage` — lcov summary 첨부 |
| TypeScript strict 오류 0개 | `npx tsc --noEmit` 출력 첨부 |
| ESLint 오류 0개 | `npx eslint . --quiet` 출력 첨부 |
| 스테이징 환경 수동 검증 완료 | Critical Path 시나리오 실행 결과 메모 첨부 |

### P4 특별 조건

P4 Phase 완료 시 Worktree MUST 룰(`worktree_rules.severity = 'MUST'`)은 `enabled = false` 상태를 유지해야 한다. P7(Telegram 채널) 완료 + Telegram bot ping 통과 확인 이후에만 `enabled = true`로 전환을 허용한다. 조기 활성화는 V-04 게이트 실패로 처리한다.

---

## 8. 릴리즈 승인 기준

프로덕션 배포 직전 단일 체크리스트. 모든 항목이 통과되어야 배포를 진행한다.

| 항목 | 확인 방법 |
|------|---------|
| 전체 테스트 통과 (유닛 + 통합 + E2E) | CI 파이프라인 최종 빌드 green |
| 코드 리뷰 승인 | PR 승인 기록 (GitHub PR review) |
| 모든 Quality Gates 통과 | 섹션 0 게이트 매핑 전 항목 Block 없음 |
| 스테이징 검증 완료 | Critical Path 3개 시나리오 모두 수동 실행 및 결과 첨부 |
| `scripts/verify_all.sh` 전체 통과 (V-01~V-10) | 스크립트 종료 코드 0 + `verify-report.txt` 첨부 |
| Telegram bot ping 통과 | `GET /channel-configs/:id/ping` → HTTP 200 확인 (MUST 룰 활성화 전제) |
| `npm audit --audit-level=high` 통과 | 종료 코드 0 (Critical/High 취약점 0건) |
| 환경변수 및 시크릿 최종 확인 | `.env.production` 하드코딩 ID 없음, `git-secrets` 또는 `truffleHog` 스캔 통과 |
